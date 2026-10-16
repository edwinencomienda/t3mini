import { afterEach, describe, expect, it } from 'vitest'
import { claudeExecutable, isNewer, parseVersion, updateProvider, updaterEnv } from './cli-updates'

describe('parseVersion', () => {
  it.each([
    ['2.1.300 (Claude Code)', '2.1.300'],
    ['codex-cli 0.162.1\n', '0.162.1'],
    ['1.0.0-beta.2', '1.0.0'],
    ['not a version', null],
  ])('reads %j', (text, version) => {
    expect(parseVersion(text)).toBe(version)
  })
})

describe('isNewer', () => {
  it.each([
    ['2.1.301', '2.1.300', true],
    ['0.163.0', '0.162.1', true],
    ['1.0.0', '0.999.999', true],
    ['0.10.0', '0.9.0', true],
    ['2.1.300', '2.1.300', false],
    ['2.1.299', '2.1.300', false],
    ['garbage', '2.1.300', false],
  ])('%s is newer than %s: %s', (latest, installed, newer) => {
    expect(isNewer(latest, installed)).toBe(newer)
  })
})

describe('updaterEnv', () => {
  it("drops the package manager's npm_* variables and keeps the rest", () => {
    expect(
      updaterEnv({
        PATH: '/usr/bin',
        HOME: '/Users/me',
        npm_config_user_agent: 'bun/1.4.3',
        npm_lifecycle_event: 'dev',
      }),
    ).toEqual({ PATH: '/usr/bin', HOME: '/Users/me' })
  })
})

describe('claudeExecutable', () => {
  const saved = process.env.CLAUDE_BIN
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_BIN
    else process.env.CLAUDE_BIN = saved
  })
  it('prefers CLAUDE_BIN', () => {
    process.env.CLAUDE_BIN = '/opt/claude/bin/claude'
    expect(claudeExecutable()).toBe('/opt/claude/bin/claude')
  })
})

it('refuses to update while a thread on that provider is running', async () => {
  process.env.CODEX_BIN = '/nonexistent/codex'
  try {
    await expect(updateProvider('codex', true)).rejects.toMatchObject({ status: 409 })
  } finally {
    delete process.env.CODEX_BIN
  }
})
