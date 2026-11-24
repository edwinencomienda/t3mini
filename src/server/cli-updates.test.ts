import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claudeExecutable,
  isNewer,
  latestProviderUpdates,
  onProviderUpdates,
  parseVersion,
  resetProviderUpdateWatch,
  updateProvider,
  updaterEnv,
} from './cli-updates'

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

it('checks in the background and tells live updates what it found', async () => {
  resetProviderUpdateWatch()
  process.env.CODEX_BIN = '/nonexistent/codex'
  process.env.CLAUDE_BIN = '/nonexistent/claude'
  // No registry calls from tests: the latest versions come from this fake.
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ version: '9.9.9' }))
  try {
    const listener = vi.fn()
    const stop = onProviderUpdates(listener)
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())
    // Not installed here, so nothing to offer; the latest versions are known.
    expect(latestProviderUpdates()).toEqual([
      { provider: 'claude', installed: null, latest: '9.9.9', available: false, updating: false },
      { provider: 'codex', installed: null, latest: '9.9.9', available: false, updating: false },
    ])
    stop()
  } finally {
    fetch.mockRestore()
    resetProviderUpdateWatch()
    delete process.env.CODEX_BIN
    delete process.env.CLAUDE_BIN
  }
})
