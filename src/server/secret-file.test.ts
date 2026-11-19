import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { envLine, saveSecret, withSecret } from './secret-file'

let project: string
const git = (...args: string[]) =>
  execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' })

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 't3-mini-secret-'))
})
afterEach(async () => {
  await rm(project, { recursive: true, force: true })
})

it('writes the variable to the env file, owner-only, and keeps other lines', async () => {
  await writeFile(join(project, '.env.local'), 'OTHER=1\nAPI_KEY=old\n')
  const result = await saveSecret(project, '.env.local', 'API_KEY', 'sk-test-123')
  expect(result).toEqual({ file: '.env.local', created: false, addedToGitignore: false })
  expect(await readFile(join(project, '.env.local'), 'utf8')).toBe('OTHER=1\nAPI_KEY=sk-test-123\n')
  expect((await stat(join(project, '.env.local'))).mode & 0o777).toBe(0o600)
  await saveSecret(project, '.env.local', 'NEW_ONE', 'with space #and "quotes" $HOME')
  expect(await readFile(join(project, '.env.local'), 'utf8')).toContain(
    'NEW_ONE="with space #and \\"quotes\\" \\$HOME"',
  )
})

it('adds the file to .gitignore in a git project, and refuses a file git tracks', async () => {
  git('init', '-q')
  const result = await saveSecret(project, '.env.local', 'API_KEY', 'secret-value')
  expect(result.addedToGitignore).toBe(true)
  expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe('/.env.local\n')
  // Already ignored now: not added twice.
  expect((await saveSecret(project, '.env.local', 'API_KEY', 'v2')).addedToGitignore).toBe(false)

  await writeFile(join(project, '.env'), 'PUBLIC=1\n')
  git('add', '-f', '.env')
  await expect(saveSecret(project, '.env', 'API_KEY', 'secret-value')).rejects.toThrow(
    'tracked by git',
  )
})

it('only writes env files inside the project, never through links, and never says the value', async () => {
  const outside = await mkdtemp(join(tmpdir(), 't3-mini-outside-'))
  try {
    for (const file of ['../.env', '/tmp/.env', 'package.json', 'config.js', '.env/../x'])
      await expect(saveSecret(project, file, 'KEY', 'secret-value')).rejects.toThrow()
    await symlink(join(outside, '.env'), join(project, '.env'))
    await expect(saveSecret(project, '.env', 'KEY', 'secret-value')).rejects.toThrow('link')
    await symlink(outside, join(project, 'linked'))
    await expect(saveSecret(project, 'linked/.env', 'KEY', 'secret-value')).rejects.toThrow(
      'inside the project',
    )
    await mkdir(join(project, 'app'))
    expect((await saveSecret(project, 'app/.dev.vars', 'KEY', 'v')).file).toBe('app/.dev.vars')
    for (const value of ['', 'two\nlines', 'tab\tinside', 'x'.repeat(20_000)]) {
      const error = await saveSecret(project, '.env', 'KEY', value).catch((caught: Error) => caught)
      expect(error).toBeInstanceOf(Error)
      if (value) expect((error as Error).message).not.toContain(value.slice(0, 20))
    }
    await expect(saveSecret(project, '.env', 'BAD-NAME', 'v')).rejects.toThrow('variable name')
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

it('formats and replaces lines', () => {
  expect(envLine('A', 'plain-value_1.2:3')).toBe('A=plain-value_1.2:3')
  expect(envLine('A', 'has space')).toBe('A="has space"')
  expect(withSecret('export A=1\nB=2', 'A', 'x')).toBe('export A=x\nB=2')
  expect(withSecret('', 'A', 'x')).toBe('A=x\n')
})
