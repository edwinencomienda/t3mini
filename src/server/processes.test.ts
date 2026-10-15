import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProcessManager } from './processes'

let manager: ProcessManager
let project: string
const until = async (check: () => boolean, ms = 5000) => {
  for (let waited = 0; waited < ms && !check(); waited += 25)
    await new Promise((resolve) => setTimeout(resolve, 25))
  expect(check()).toBe(true)
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  // A plain shell keeps tests fast (no login profile).
  vi.stubEnv('SHELL', '/bin/sh')
  project = await realpath(await mkdtemp(join(tmpdir(), 't3-mini-proc-')))
  manager = new ProcessManager()
})
afterEach(async () => {
  await manager.stopAll()
  vi.unstubAllEnvs()
  await rm(project, { recursive: true, force: true })
})

it('runs a server-like process, finds its URL, and stops it with its children', async () => {
  const info = manager.start({
    name: 'Dev server',
    // A background child (like a bundler worker) plus a foreground "server".
    command: 'sleep 60 & echo "child $!"; echo "  Local:   http://0.0.0.0:5173/"; exec sleep 60',
    cwd: project,
    project,
  })
  await until(() => Boolean(manager.get(info.id)?.url))
  expect(manager.get(info.id)).toMatchObject({ status: 'running', url: 'http://localhost:5173/' })
  const childPid = Number(/child (\d+)/.exec(manager.logs(info.id) ?? '')?.[1])
  expect(alive(childPid)).toBe(true)
  await manager.stop(info.id)
  expect(manager.get(info.id)?.status).toBe('stopped')
  await until(() => !alive(childPid))
})
it('records failures with the exit code, and restarts the same command', async () => {
  const failed = manager.start({
    name: 'Broken',
    command: 'echo boom; exit 3',
    cwd: project,
    project,
  })
  await until(() => manager.get(failed.id)?.status === 'failed')
  expect(manager.get(failed.id)).toMatchObject({ exitCode: 3 })
  expect(manager.logs(failed.id)).toContain('boom')
  await manager.restart(failed.id)
  await until(() => manager.get(failed.id)?.status === 'failed')
  expect(manager.logs(failed.id)).toContain('Restarted')
})
it("doesn't pass t3 mini's secrets to processes", async () => {
  vi.stubEnv('DEEPGRAM_API_KEY', 'secret-value')
  const info = manager.start({
    name: 'Env',
    command: 'echo "[$DEEPGRAM_API_KEY]"',
    cwd: project,
    project,
  })
  await until(() => manager.get(info.id)?.status === 'exited')
  expect(manager.logs(info.id)).toContain('[]')
  expect(manager.logs(info.id)).not.toContain('secret-value')
})
it('lists by project and caps running processes per project', async () => {
  for (let index = 0; index < 10; index++)
    manager.start({ name: `p${index}`, command: 'exec sleep 60', cwd: project, project })
  expect(() =>
    manager.start({ name: 'one too many', command: 'exec sleep 60', cwd: project, project }),
  ).toThrow('10 running')
  expect(manager.list(project)).toHaveLength(10)
  expect(manager.list('/elsewhere')).toHaveLength(0)
})
