import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createWorktree,
  removeWorktree,
  repoRoot,
  worktreeChanges,
  worktreeFolder,
  worktreesRoot,
} from './worktrees'

// A small repository with an ignored .env, a .worktreeinclude naming it, and worktrees in a
// temporary folder instead of ~/.t3-mini.
let base: string
let repo: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 't3m-worktrees-'))
  process.env.T3_MINI_WORKTREES_DIR = join(base, 'worktrees')
  repo = join(base, 'app')
  await mkdir(join(repo, 'web'), { recursive: true })
  git(base, 'init', '-q', '-b', 'main', repo)
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  await writeFile(join(repo, '.gitignore'), '.env\nnode_modules/\nsecret-link\n')
  await writeFile(join(repo, '.worktreeinclude'), '.env\nREADME.md\nsecret-link\n')
  await writeFile(join(repo, 'README.md'), '# app\n')
  await writeFile(join(repo, 'web', 'index.ts'), 'export {}\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  await writeFile(join(repo, '.env'), 'TOKEN=test\n')
  await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(repo, 'node_modules', 'left-pad', 'index.js'), '')
  await symlink(join(repo, '.env'), join(repo, 'secret-link'))
})
afterEach(async () => {
  delete process.env.T3_MINI_WORKTREES_DIR
  await rm(base, { recursive: true, force: true })
})

it('creates a worktree on its own branch from HEAD, copying only ignored listed files', async () => {
  const head = git(repo, 'rev-parse', 'HEAD')
  const worktree = await createWorktree(repo, '1234abcd-0000-0000-0000-000000000000')
  expect(worktree).toMatchObject({ branch: 't3m/1234abcd', base: head, copied: 1 })
  expect(worktree.path.startsWith(worktreesRoot())).toBe(true)
  expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('t3m/1234abcd')
  // .env is ignored and listed: copied. README is tracked (already there), node_modules isn't
  // listed, and the symlink is skipped.
  expect(await readFile(join(worktree.path, '.env'), 'utf8')).toBe('TOKEN=test\n')
  expect(await exists(join(worktree.path, 'node_modules'))).toBe(false)
  expect(await exists(join(worktree.path, 'secret-link'))).toBe(false)
  // The main checkout stays on its branch.
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
})

it('works from a subfolder of the repository', async () => {
  const worktree = await createWorktree(join(repo, 'web'), 'abcdef12-0000-0000-0000-000000000000')
  expect(worktree.subdir).toBe('web')
  expect(await exists(join(worktreeFolder(worktree), 'index.ts'))).toBe(true)
  expect(await repoRoot(join(repo, 'web'))).toBe(worktree.repo)
})

it('reports uncommitted changes, removes the folder but keeps the branch', async () => {
  const worktree = await createWorktree(repo, 'feedbeef-0000-0000-0000-000000000000')
  expect(await worktreeChanges(worktree)).toBe(0)
  await writeFile(join(worktree.path, 'new.txt'), 'hi\n')
  expect(await worktreeChanges(worktree)).toBe(1)
  git(worktree.path, 'add', '.')
  git(worktree.path, 'commit', '-q', '-m', 'work')
  expect(await worktreeChanges(worktree)).toBe(0)
  await removeWorktree(worktree)
  expect(await exists(worktree.path)).toBe(false)
  // Its repository's folder goes too, now that it's empty.
  expect(await exists(join(worktree.path, '..'))).toBe(false)
  expect(await worktreeChanges(worktree)).toBeNull()
  expect(git(repo, 'branch', '--list', 't3m/feedbeef')).toContain('t3m/feedbeef')
  // Removing again (already gone) is fine.
  await removeWorktree(worktree)
})

it('refuses folders outside its worktrees folder and repositories without commits', async () => {
  const worktree = await createWorktree(repo, '0badc0de-0000-0000-0000-000000000000')
  await expect(removeWorktree({ ...worktree, path: repo })).rejects.toThrow(/didn’t create/)
  expect(await exists(repo)).toBe(true)
  const empty = join(base, 'empty')
  git(base, 'init', '-q', empty)
  await expect(createWorktree(empty, 'aaaaaaaa-0000')).rejects.toThrow(/first commit/)
  await expect(createWorktree(base, 'bbbbbbbb-0000')).rejects.toThrow(/git repository/)
})
