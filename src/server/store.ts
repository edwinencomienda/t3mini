import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Thread } from '../types'
import { isActive } from '../types'
import { legacyPermission } from '../agent-settings'

export class ThreadStore {
  threads = new Map<string, Thread>()
  private queue: Promise<void> = Promise.resolve()
  constructor(private path: string) {}
  async load() {
    try {
      const saved: Thread[] = JSON.parse(await readFile(this.path, 'utf8'))
      for (const thread of saved) {
        thread.effort ??= ''
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
    const write = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(this.path + '.tmp', contents, { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
    })
    this.queue = write.catch(() => {})
    return write
  }
}
export const defaultStorePath = () =>
  join(process.env.T3_MINI_DATA_DIR || join(process.cwd(), '.data'), 'threads.json')
