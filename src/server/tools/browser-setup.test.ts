import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPageUrl, consoleText, isLocalPage, mockMatches } from '../browser'
import { readValueFrom, toMock } from './browser-setup'

const project = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), 't3-mini-browser-setup-'))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  return root
}
const t3 = new Set([4310])
const check = (url: string) => checkPageUrl(url, t3, async () => false)

describe('console messages', () => {
  it('fills in %s placeholders the way the developer tools show them', () => {
    // What Playwright gives for console.error('…`%s`…', 'gmwt9'): the template, then the args.
    expect(
      consoleText('Encountered two children with the same key, `%s`. Keys… gmwt9', [
        'Encountered two children with the same key, `%s`. Keys…',
        'gmwt9',
      ]),
    ).toBe('Encountered two children with the same key, `gmwt9`. Keys…')
    expect(consoleText('', ['%d items, %s %o', '3.7', 'left', '{a: 1}', 'extra'])).toBe(
      '3 items, left {a: 1} extra',
    )
    expect(consoleText('', ['%cStyled', 'color: red'])).toBe('Styled')
    expect(consoleText('', ['100%% done'])).toBe('100% done')
    // Nothing to fill in: Playwright's own text.
    expect(consoleText('plain {b: 2}', ['plain', '{b: 2}'])).toBe('plain {b: 2}')
    expect(consoleText('Missing %s', ['Missing %s'])).toBe('Missing %s')
  })
})

describe('mock URL patterns', () => {
  it('matches paths on any local site, or full URLs, with * and **', () => {
    expect(mockMatches('/api/me', 'http://localhost:3000/api/me')).toBe(true)
    expect(mockMatches('/api/me', 'http://localhost:3000/api/me?fresh=1')).toBe(true)
    expect(mockMatches('/api/me', 'http://localhost:3000/api/men')).toBe(false)
    expect(mockMatches('/api/me?x=1', 'http://localhost:3000/api/me?x=2')).toBe(false)
    expect(mockMatches('/api/sessions/*', 'http://localhost/api/sessions/42')).toBe(true)
    expect(mockMatches('/api/sessions/*', 'http://localhost/api/sessions/42/players')).toBe(false)
    expect(mockMatches('/api/**', 'http://localhost/api/sessions/42/players')).toBe(true)
    expect(mockMatches('http://localhost:3000/api/**', 'http://localhost:3000/api/a?b=1')).toBe(
      true,
    )
    expect(mockMatches('http://localhost:3000/api/**', 'http://localhost:4000/api/a')).toBe(false)
    // Regex characters in a pattern are plain text.
    expect(mockMatches('/a.b', 'http://localhost/aXb')).toBe(false)
  })
  it('only mocks local sites, never public ones or t3 mini', async () => {
    const mock = (url: string) => toMock({ url, json: { ok: true } }, check, isLocalPage)
    expect(await mock('/api/me')).toMatchObject({
      url: '/api/me',
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true}',
    })
    expect(await mock('http://localhost:3000/api/**')).toMatchObject({ status: 200 })
    await expect(mock('https://example.com/api/me')).rejects.toThrow(/only work for local sites/)
    await expect(mock('http://localhost:4310/api/threads')).rejects.toThrow(/t3 mini itself/)
    await expect(mock('http://*.example.com/api')).rejects.toThrow(/no \* in the address/)
    await expect(toMock({ url: '/x', json: {}, body: 'both' }, check, isLocalPage)).rejects.toThrow(
      /either json or body/,
    )
  })
})

describe('values from project files', () => {
  it('reads a JSON key, an env variable, or a one-line file', async () => {
    const root = await project({
      '.fixtures/last.json': JSON.stringify({ id: 'abc', host: { token: 'secret-token' } }),
      '.env.local': 'export SESSION_TOKEN="from-env" # comment\nOTHER=x\n',
      'token.txt': 'one-line-token\n',
      'two.txt': 'a\nb\n',
    })
    expect(await readValueFrom(root, { file: '.fixtures/last.json', key: 'host.token' })).toBe(
      'secret-token',
    )
    expect(await readValueFrom(root, { file: '.env.local', key: 'SESSION_TOKEN' })).toBe('from-env')
    expect(await readValueFrom(root, { file: 'token.txt' })).toBe('one-line-token')
  })
  it('never says what the file holds, and stays inside the project', async () => {
    const root = await project({
      'data.json': JSON.stringify({ token: 'secret-token', nested: { deep: true } }),
      'broken.json': '{"token": "secret-token"',
      'two.txt': 'secret-a\nsecret-b\n',
    })
    const failures = [
      () => readValueFrom(root, { file: 'data.json', key: 'missing' }),
      () => readValueFrom(root, { file: 'data.json', key: 'nested' }),
      () => readValueFrom(root, { file: 'broken.json', key: 'token' }),
      () => readValueFrom(root, { file: 'two.txt' }),
    ]
    for (const failure of failures) {
      const error = await failure().then(
        () => undefined,
        (reason: Error) => reason,
      )
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).not.toMatch(/secret/)
    }
    await expect(readValueFrom(root, { file: '../outside.json', key: 'x' })).rejects.toThrow(
      /not found|inside the project/,
    )
    await expect(readValueFrom(root, { file: '/etc/hosts' })).rejects.toThrow(/inside the project/)
    // Not the temp folder either (other tools may read there), and no way out through a link.
    const elsewhere = await project({ 'token.txt': 'secret' })
    await expect(readValueFrom(root, { file: join(elsewhere, 'token.txt') })).rejects.toThrow(
      /inside the project/,
    )
    await symlink(join(elsewhere, 'token.txt'), join(root, 'link.txt'))
    await expect(readValueFrom(root, { file: 'link.txt' })).rejects.toThrow(/inside the project/)
  })
})
