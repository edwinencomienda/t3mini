// A newer t3mini installed while this one runs (bun run install-cli, t3mini update): the sidebar
// offers to restart onto it (components/AppUpdate.tsx).
//
// Only the installed binary does this. `t3mini serve` (cli/t3mini.ts) passes the binary's path
// and which file it started from (inode and modified time); installs rename a new file over the
// binary, so a different file there means an update is waiting. The dev server has neither, so
// it never offers one.
//
// Restarting runs `t3mini restart` from the new binary as a detached process: it stops this
// server (SIGTERM, which ends running turns), then starts the new one, and isn't stopped with
// it. "When idle" waits for every agent to finish first.

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'

export type AppUpdate = {
  // A newer t3mini is installed than the one running.
  ready: boolean
  // The commit it was built from, when installed from the repo.
  commit?: string
  // Restarting once no agent is working.
  whenIdle: boolean
}

const fileId = (info: { ino: number; mtimeMs: number }) => `${info.ino}:${Math.round(info.mtimeMs)}`

let whenIdle = false
let restarting = false

export async function appUpdate(env: NodeJS.ProcessEnv = process.env): Promise<AppUpdate> {
  const binary = env.T3_MINI_BINARY
  const started = env.T3_MINI_BINARY_ID
  if (!binary || !started) return { ready: false, whenIdle: false }
  const now = await stat(binary).catch(() => null)
  // Missing (mid-install, or removed): nothing to restart onto yet.
  if (!now || fileId(now) === started) return { ready: false, whenIdle: false }
  const install = env.T3_MINI_INSTALL_FILE
    ? await readFile(env.T3_MINI_INSTALL_FILE, 'utf8')
        .then((text) => JSON.parse(text) as { commit?: unknown })
        .catch(() => null)
    : null
  const commit =
    typeof install?.commit === 'string' && /^[0-9a-f]{4,40}$/.test(install.commit)
      ? install.commit
      : undefined
  return { ready: true, ...(commit ? { commit } : {}), whenIdle }
}

export { fileId as binaryFileId }

// Restarts onto the new binary now. Fixed arguments, no shell.
export async function restartApp(env: NodeJS.ProcessEnv = process.env) {
  if (!(await appUpdate(env)).ready) throw new Error('No update is waiting.')
  if (restarting) return
  restarting = true
  const child = spawn(env.T3_MINI_BINARY!, ['restart', '--port', String(env.PORT || 4011)], {
    cwd: homedir(),
    detached: true,
    stdio: 'ignore',
    env,
  })
  // Exiting while this server still runs means the restart didn't happen: allow another try.
  child.on('error', () => (restarting = false))
  child.on('exit', () => (restarting = false))
  child.unref()
}

// Restarts as soon as no agent is working (checked every few seconds), or stops waiting.
let timer: ReturnType<typeof setInterval> | undefined
export function restartWhenIdle(
  enabled: boolean,
  busy: () => boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  whenIdle = enabled
  clearInterval(timer)
  timer = undefined
  if (!enabled) return
  const check = () => {
    if (busy()) return
    clearInterval(timer)
    timer = undefined
    whenIdle = false
    void restartApp(env).catch(() => {})
  }
  timer = setInterval(check, 3000)
  check()
}
