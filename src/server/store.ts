import { hash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isImageId } from './uploads'
import { dirname, join } from 'node:path'
import type { Project, Thread, UiSettings } from '../types'
import { readUiSettings } from './ui-settings'
import { isActive } from '../types'
import { legacyPermission } from '../agent-settings'
import { stopLeftoverCards } from './delegations'

// One file per thread in `threads/` (for `threads.json`), so a save writes only the threads that
// changed (a streaming reply used to rewrite every thread, ~13 MB, every second). `path` itself
// is the old single-file layout, moved in once and kept as `threads.json.migrated`.
const fileName = (id: string) => `${encodeURIComponent(id)}.json`
// Bun's hash is ~5× cheaper than sha256 here (this runs over every thread on each save); it
// only decides what to rewrite, so it needn't be cryptographic. Node (dev, tests) has no Bun.
const bun = (globalThis as { Bun?: { hash(input: string): number | bigint } }).Bun
const digest = (contents: string) =>
  `${contents.length}:${bun ? bun.hash(contents) : hash('sha256', contents)}`
type Changes = { writes: { id: string; contents: string; digest: string }[]; removes: string[] }

export class ThreadStore {
  threads = new Map<string, Thread>()
  private queue: Promise<void> = Promise.resolve()
  // What each thread's file holds (a hash of its JSON), to skip threads that didn't change.
  private written = new Map<string, string>()
  readonly folder: string
  constructor(readonly path: string) {
    // threads.json → threads/ (each store its own folder, even side by side).
    this.folder = path.replace(/\.json$/, '') + (path.endsWith('.json') ? '' : '.d')
  }
  // Every thread's file, as written (hashed so the first save skips unchanged ones).
  private async readFolder(): Promise<Thread[] | null> {
    let names: string[]
    try {
      names = (await readdir(this.folder)).filter((name) => name.endsWith('.json'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    return Promise.all(
      names.map(async (name) => {
        const contents = await readFile(join(this.folder, name), 'utf8')
        const thread: Thread = JSON.parse(contents)
        this.written.set(thread.id, digest(contents))
        return thread
      }),
    )
  }
  // The old single file, split into the folder. The folder appears whole (staged, then renamed)
  // before the old file moves aside, so a crash midway leaves one complete layout or the other.
  private async migrate(): Promise<Thread[]> {
    const saved: Thread[] = JSON.parse(await readFile(this.path, 'utf8'))
    const staging = this.folder + '.migrating'
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true, mode: 0o700 })
    await Promise.all(
      saved.map(async (thread) => {
        const contents = JSON.stringify(thread)
        await writeFile(join(staging, fileName(thread.id)), contents, { mode: 0o600 })
        this.written.set(thread.id, digest(contents))
      }),
    )
    await rename(staging, this.folder)
    await rename(this.path, this.path + '.migrated')
    return saved
  }
  async load() {
    try {
      const saved = (await this.readFolder()) ?? (await this.migrate())
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
        // Sub-agent cards still marked running: nothing survived the restart.
        stopLeftoverCards(thread, new Date().toISOString())
        this.threads.set(thread.id, thread)
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  // A saveSoon() that hasn't written yet.
  private pending?: NodeJS.Timeout
  save() {
    // This writes everything that changed, so a pending saveSoon() has nothing left to do.
    this.cancelPending()
    // Snapshot before queueing writes; only one save writes at a time.
    const changes = this.changes()
    const write = this.queue.then(() => this.apply(changes))
    this.queue = write.catch(() => {})
    return write
  }
  // Threads whose JSON differs from their file, and files of threads that are gone.
  private changes(): Changes {
    const writes: Changes['writes'] = []
    for (const [id, thread] of this.threads) {
      const contents = JSON.stringify(thread)
      const hashed = digest(contents)
      if (this.written.get(id) !== hashed) writes.push({ id, contents, digest: hashed })
    }
    const removes = [...this.written.keys()].filter((id) => !this.threads.has(id))
    return { writes, removes }
  }
  // A thread is only marked written once its file is, so a failed write is retried next save.
  private async apply({ writes, removes }: Changes) {
    if (writes.length) await mkdir(this.folder, { recursive: true, mode: 0o700 })
    const results = await Promise.allSettled([
      ...writes.map(async (item) => {
        await writeAtomic(join(this.folder, fileName(item.id)), item.contents)
        this.written.set(item.id, item.digest)
      }),
      ...removes.map(async (id) => {
        await rm(join(this.folder, fileName(id)), { force: true })
        if (!this.threads.has(id)) this.written.delete(id)
      }),
    ])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  // Saves within saveDelay, however many changes come in meanwhile. Streamed replies change
  // threads ten times a second, so they're written at most once a second instead (the browser
  // still gets every update). Turn ends and other changes that must not be lost still call
  // save() directly, and t3 mini writes a pending save on exit.
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
  // Writes a pending saveSoon() right away, synchronously (for the exit hook). Atomic writes,
  // like save(); a file that fails to write is left as it was.
  flushNow() {
    if (!this.pending) return
    this.cancelPending()
    const { writes, removes } = this.changes()
    try {
      if (writes.length) mkdirSync(this.folder, { recursive: true, mode: 0o700 })
    } catch {
      return // Nothing more can be done while exiting.
    }
    for (const item of writes) {
      const path = join(this.folder, fileName(item.id))
      try {
        writeFileSync(path + '.tmp', item.contents, { mode: 0o600 })
        renameSync(path + '.tmp', path)
        this.written.set(item.id, item.digest)
      } catch {
        // The others still get written.
      }
    }
    for (const id of removes) rmSync(join(this.folder, fileName(id)), { force: true })
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
