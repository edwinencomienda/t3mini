import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Project, Thread } from '../types'
import { isActive } from '../types'
import { legacyPermission } from '../agent-settings'

export class ThreadStore {
  threads = new Map<string, Thread>()
  private queue: Promise<void> = Promise.resolve()
  constructor(readonly path: string) {}
  async load() {
    try {
      const saved: Thread[] = JSON.parse(await readFile(this.path, 'utf8'))
      for (const thread of saved) {
        thread.effort ??= ''
        // The queue of mid-turn messages lives in memory, so after a restart none will be sent.
        for (const message of thread.messages)
          if (message.queued) {
            delete message.queued
            message.unsent = true
          }
        thread.permissionMode ??= legacyPermission(thread.provider)
        if (isActive(thread.status)) {
          thread.status = 'interrupted'
          thread.completedAt = new Date().toISOString()
          thread.error = 'The server restarted during this turn.'
          thread.approvals = []
          thread.activities = thread.activities.map((activity) =>
            activity.status === 'running' ? { ...activity, status: 'failed' } : activity,
          )
        }
        this.threads.set(thread.id, thread)
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  save() {
    // Serialize snapshots before queueing writes; only one atomic rename can run at a time.
    const contents = JSON.stringify([...this.threads.values()])
    const write = this.queue.then(() => writeAtomic(this.path, contents))
    this.queue = write.catch(() => {})
    return write
  }
}
export const defaultStorePath = () =>
  join(process.env.T3_MINI_DATA_DIR || join(process.cwd(), '.data'), 'threads.json')

// Atomic JSON write shared by the stores: write a temp file, then rename over the original.
async function writeAtomic(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path + '.tmp', contents, { mode: 0o600 })
  await rename(path + '.tmp', path)
}
export class ProjectStore {
  projects = new Map<string, Project>()
  private queue: Promise<void> = Promise.resolve()
  constructor(readonly path: string) {}
  async load() {
    try {
      const saved: Project[] = JSON.parse(await readFile(this.path, 'utf8'))
      for (const project of saved)
        if (typeof project?.path === 'string' && typeof project.addedAt === 'string')
          this.projects.set(project.path, {
            path: project.path,
            addedAt: project.addedAt,
            ...(typeof project.name === 'string' && project.name ? { name: project.name } : {}),
          })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  save() {
    const contents = JSON.stringify([...this.projects.values()])
    const write = this.queue.then(() => writeAtomic(this.path, contents))
    this.queue = write.catch(() => {})
    return write
  }
}
export const projectStorePath = (threadStorePath: string) =>
  join(dirname(threadStorePath), 'projects.json')
