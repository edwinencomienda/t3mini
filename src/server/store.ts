import { renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isImageId } from './uploads'
import { dirname, join } from 'node:path'
import type { Project, Thread, UiSettings } from '../types'
import { readUiSettings } from './ui-settings'
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
  // A saveSoon() that hasn't written yet.
  private pending?: NodeJS.Timeout
  save() {
    // This writes everything, so a pending saveSoon() has nothing left to do.
    this.cancelPending()
    // Serialize snapshots before queueing writes; only one atomic rename can run at a time.
    const contents = JSON.stringify([...this.threads.values()])
    const write = this.queue.then(() => writeAtomic(this.path, contents))
    this.queue = write.catch(() => {})
    return write
  }
  // Saves within saveDelay, however many changes come in meanwhile. Streamed replies change
  // threads ten times a second, and each save rewrites every thread, so they're written at most
  // once a second instead (the browser still gets every update). Turn ends and other changes
  // that must not be lost still call save() directly, and t3 mini writes a pending save on exit.
  saveSoon(onError: () => void) {
    if (this.pending) return
    pendingStores.add(this)
    hookExit()
    this.pending = setTimeout(() => {
      this.cancelPending()
      this.save().catch(onError)
    }, saveDelay)
    // Waiting to save doesn't keep the process alive; the exit hook writes it.
    this.pending.unref?.()
  }
  // Writes a pending saveSoon() right away, synchronously (for the exit hook). An atomic write,
  // like save(); if it fails, the last saved file is left as it was.
  flushNow() {
    if (!this.pending) return
    this.cancelPending()
    try {
      writeFileSync(this.path + '.tmp', JSON.stringify([...this.threads.values()]), {
        mode: 0o600,
      })
      renameSync(this.path + '.tmp', this.path)
    } catch {
      // Nothing more can be done while exiting.
    }
  }
  private cancelPending() {
    if (!this.pending) return
    clearTimeout(this.pending)
    this.pending = undefined
    pendingStores.delete(this)
  }
}
export const saveDelay = 1000
// Stores with a saveSoon() waiting, written out when the process exits (signals end in
// process.exit, which runs 'exit' hooks; see processes.ts and app-server.mjs).
const pendingStores = new Set<ThreadStore>()
let exitHooked = false
function hookExit() {
  if (exitHooked) return
  exitHooked = true
  process.once('exit', () => pendingStores.forEach((store) => store.flushNow()))
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
            ...(typeof project.lastActiveAt === 'string'
              ? { lastActiveAt: project.lastActiveAt }
              : {}),
            ...(project.avatar === 'letter' ? { avatar: 'letter' as const } : {}),
            ...(project.avatar === 'image' && isImageId(project.image)
              ? { avatar: 'image' as const, image: project.image }
              : {}),
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
// View settings shared across browsers (see UiSettings), in .data/ui.json.
export class UiStore {
  settings: UiSettings = { groupBy: 'project' }
  private queue: Promise<void> = Promise.resolve()
  constructor(readonly path: string) {}
  async load() {
    try {
      this.settings = readUiSettings(JSON.parse(await readFile(this.path, 'utf8'))) as UiSettings
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  save() {
    const contents = JSON.stringify(this.settings)
    const write = this.queue.then(() => writeAtomic(this.path, contents))
    this.queue = write.catch(() => {})
    return write
  }
}
export const uiStorePath = (threadStorePath: string) => join(dirname(threadStorePath), 'ui.json')
export const projectStorePath = (threadStorePath: string) =>
  join(dirname(threadStorePath), 'projects.json')
