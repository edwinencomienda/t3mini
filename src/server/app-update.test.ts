import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appUpdate, binaryFileId, restartApp, restartWhenIdle } from './app-update'

let dir: string
let env: NodeJS.ProcessEnv
// A stand-in for the binary: records the arguments it's run with.
const fakeBinary = (marker: string) => `#!/bin/sh\necho "$@" > "${marker}"\n`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't3-app-update-'))
  const binary = join(dir, 't3mini')
  await writeFile(binary, fakeBinary(join(dir, 'ran')), { mode: 0o755 })
  env = {
    T3_MINI_BINARY: binary,
    T3_MINI_BINARY_ID: binaryFileId(await stat(binary)),
    T3_MINI_INSTALL_FILE: join(dir, 'install.json'),
    PORT: '4099',
  }
})
afterEach(async () => {
  restartWhenIdle(false, () => false, env)
  await rm(dir, { recursive: true, force: true })
})

// What install-cli and `t3mini update` do: a new file renamed over the binary.
async function installNewBinary(commit?: string) {
  const staged = join(dir, '.t3mini.new')
  await writeFile(staged, fakeBinary(join(dir, 'ran')), { mode: 0o755 })
  await rename(staged, env.T3_MINI_BINARY!)
  if (commit !== undefined) await writeFile(env.T3_MINI_INSTALL_FILE!, JSON.stringify({ commit }))
}
const ran = async () => {
  for (let i = 0; i < 50; i++) {
    const text = await readFile(join(dir, 'ran'), 'utf8').catch(() => '')
    if (text) return text.trim()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return ''
}

describe('appUpdate', () => {
  it('offers nothing in dev (no installed binary)', async () => {
    expect(await appUpdate({})).toEqual({ ready: false, whenIdle: false })
  })

  it('offers nothing while the binary is the one it started from', async () => {
    expect((await appUpdate(env)).ready).toBe(false)
  })

  it('offers a restart once a new binary is installed over it, with its commit', async () => {
    await installNewBinary('cbed45d')
    expect(await appUpdate(env)).toEqual({ ready: true, commit: 'cbed45d', whenIdle: false })
  })

  it("leaves out a commit that doesn't look like one", async () => {
    await installNewBinary('<script>')
    expect(await appUpdate(env)).toEqual({ ready: true, whenIdle: false })
  })

  it('offers nothing while the binary is missing (mid-install)', async () => {
    await rm(env.T3_MINI_BINARY!)
    expect((await appUpdate(env)).ready).toBe(false)
  })
})

describe('restartApp', () => {
  it('refuses without an update', async () => {
    await expect(restartApp(env)).rejects.toThrow('No update is waiting.')
  })

  it('runs `t3mini restart` on its port from the new binary', async () => {
    await installNewBinary()
    await restartApp(env)
    expect(await ran()).toBe('restart --port 4099')
  })
})

describe('restartWhenIdle', () => {
  it('waits while an agent works', async () => {
    await installNewBinary()
    restartWhenIdle(true, () => true, env)
    expect((await appUpdate(env)).whenIdle).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await readFile(join(dir, 'ran'), 'utf8').catch(() => '')).toBe('')
  })

  it('restarts as soon as nothing is working', async () => {
    await installNewBinary()
    restartWhenIdle(true, () => false, env)
    expect(await ran()).toBe('restart --port 4099')
  })
})
