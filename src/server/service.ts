import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  isActive,
  type Bootstrap,
  type ProjectSummary,
  type Provider,
  type Thread,
  type ThreadSummary,
} from '../types'
import { ProjectStore, ThreadStore, defaultStorePath, projectStorePath } from './store'
import { UploadError, Uploads, attachmentSchema } from './uploads'
import { parseDiff, type DiffFile, type DiffResult } from '../diff'
import { runCodex } from './providers/codex'
import { runClaude } from './providers/claude'
import type { PromptImage, Runner } from './providers/types'
import { defaultPermission } from '../agent-settings'
import { settingsSchema } from './provider-settings'
import { validateEffort } from './models'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
const createSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  cwd: z.string().trim().min(1),
  model: settingsSchema.shape.model.default(''),
  effort: settingsSchema.shape.effort.default(''),
  permissionMode: settingsSchema.shape.permissionMode.optional(),
})
const projectSchema = z.object({ path: z.string().trim().min(1).max(4096) })
const promptSchema = z
  .object({
    text: z.string().trim().max(100_000),
    attachments: z.array(attachmentSchema).max(10).default([]),
  })
  .refine(
    (prompt) => prompt.text || prompt.attachments.length,
    'Write a message or attach an image.',
  )
const exec = promisify(execFile)
function lastMessageAt(thread: Thread) {
  for (let index = thread.messages.length - 1; index >= 0; index--)
    if (thread.messages[index]!.role === 'user') return thread.messages[index]!.createdAt
  return thread.createdAt
}
const summary = (thread: Thread): ThreadSummary => ({
  id: thread.id,
  title: thread.title,
  provider: thread.provider,
  cwd: thread.cwd,
  status: thread.status,
  updatedAt: thread.updatedAt,
  lastMessageAt: lastMessageAt(thread),
})
// Expands ~, requires an absolute path, and resolves symlinks to the real directory.
async function resolveFolder(input: string) {
  const expanded =
    input === '~' ? homedir() : input.startsWith('~/') ? join(homedir(), input.slice(2)) : input
  if (!isAbsolute(expanded))
    throw new HttpError(400, 'Use an absolute project folder path, or start with ~/ .')
  try {
    const path = await realpath(expanded)
    if (!(await stat(path)).isDirectory()) throw new Error()
    return path
  } catch {
    throw new HttpError(400, 'That project folder does not exist on this machine.')
  }
}
type Run = {
  controller: AbortController
  approvals: Map<string, (allow: boolean) => void>
  done: Promise<void>
}

export class AgentService {
  private runs = new Map<string, Run>()
  private settingsUpdates = new Set<string>()
  private listeners = new Set<() => void>()
  private timer?: NodeJS.Timeout
  private persistenceError?: string
  constructor(
    readonly store: ThreadStore,
    private runners: Record<Provider, Runner> = { codex: runCodex, claude: runClaude },
    readonly projectStore = new ProjectStore(projectStorePath(store.path)),
    readonly uploads = new Uploads(join(dirname(store.path), 'attachments')),
  ) {}
  async upload(input: unknown) {
    try {
      return await this.uploads.save(input)
    } catch (error) {
      if (error instanceof UploadError) throw new HttpError(400, error.message)
      throw error
    }
  }
  list() {
    return [...this.store.threads.values()]
      .map(summary)
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
  }
  // Saved projects plus any folder that has threads, ordered by your most recent message
  // (or when the project was added), not by agent activity.
  projects(): ProjectSummary[] {
    const projects = new Map<string, ProjectSummary>()
    for (const project of this.projectStore.projects.values())
      projects.set(project.path, {
        path: project.path,
        lastActiveAt: project.addedAt,
        threadCount: 0,
      })
    for (const thread of this.store.threads.values()) {
      const sentAt = lastMessageAt(thread)
      const project = projects.get(thread.cwd) ?? {
        path: thread.cwd,
        lastActiveAt: sentAt,
        threadCount: 0,
      }
      project.threadCount++
      if (sentAt > project.lastActiveAt) project.lastActiveAt = sentAt
      projects.set(thread.cwd, project)
    }
    return [...projects.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }
  async addProject(input: unknown) {
    const path = await resolveFolder(projectSchema.parse(input).path)
    if (!this.projectStore.projects.has(path)) {
      this.projectStore.projects.set(path, { path, addedAt: new Date().toISOString() })
      try {
        await this.projectStore.save()
      } catch {
        this.projectStore.projects.delete(path)
        throw new HttpError(500, 'Could not save the project.')
      }
      this.notify()
    }
    return this.projects().find((project) => project.path === path)!
  }
  async removeProject(input: unknown) {
    const { path } = projectSchema.parse(input)
    if ([...this.store.threads.values()].some((thread) => thread.cwd === path))
      throw new HttpError(409, 'Delete this project’s threads before removing it.')
    const project = this.projectStore.projects.get(path)
    if (!project) throw new HttpError(404, 'Project not found.')
    this.projectStore.projects.delete(path)
    try {
      await this.projectStore.save()
    } catch {
      this.projectStore.projects.set(path, project)
      throw new HttpError(500, 'Could not remove the project.')
    }
    this.notify()
    return { ok: true }
  }
  get(id: string) {
    const thread = this.store.threads.get(id)
    if (!thread) throw new HttpError(404, 'Thread not found.')
    return thread
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private notify() {
    for (const listener of this.listeners) listener()
  }
  private changed() {
    // Batch text bursts so the browser and disk are updated at most ten times a second.
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.store.save().catch(() => {
          this.persistenceError =
            'Could not save conversations. Check disk space and permissions, then restart the server.'
          this.notify()
        })
        this.notify()
      }, 100)
  }
  snapshot(id?: string) {
    return {
      threads: this.list(),
      projects: this.projects(),
      thread: id ? (this.store.threads.get(id) ?? null) : null,
      persistenceError: this.persistenceError,
    }
  }
  async bootstrap(): Promise<Bootstrap> {
    const check = async (provider: Provider) => {
      try {
        const { stdout } = await exec(
          process.env[provider === 'codex' ? 'CODEX_BIN' : 'CLAUDE_BIN'] || provider,
          ['--version'],
          { timeout: 5_000 },
        )
        return { installed: true, version: stdout.trim().split('\n')[0] }
      } catch {
        return { installed: false }
      }
    }
    const [codex, claude] = await Promise.all([check('codex'), check('claude')])
    return {
      threads: this.list(),
      projects: this.projects(),
      providers: { codex, claude },
      defaultCwd: homedir(),
    }
  }
  async create(input: unknown) {
    const data = createSchema.parse(input)
    const cwd = await resolveFolder(data.cwd)
    try {
      await validateEffort(data.provider, cwd, data)
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid effort level.')
    }
    const now = new Date().toISOString()
    const thread: Thread = {
      id: crypto.randomUUID(),
      title: 'New thread',
      provider: data.provider,
      cwd,
      model: data.model,
      effort: data.effort,
      permissionMode: data.permissionMode ?? defaultPermission,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      messages: [],
      activities: [],
      approvals: [],
    }
    this.store.threads.set(thread.id, thread)
    try {
      await this.store.save()
    } catch {
      this.store.threads.delete(thread.id)
      throw new HttpError(500, 'Could not save the new thread.')
    }
    if (!this.projectStore.projects.has(cwd)) {
      // Keep the folder in the sidebar even after its threads are deleted. Best effort:
      // the thread already exists, and the folder still appears while it has threads.
      this.projectStore.projects.set(cwd, { path: cwd, addedAt: now })
      await this.projectStore.save().catch(() => this.projectStore.projects.delete(cwd))
    }
    this.notify()
    return thread
  }
  async updateSettings(id: string, input: unknown) {
    const thread = this.get(id)
    if (this.runs.has(id) || this.settingsUpdates.has(id))
      throw new HttpError(
        409,
        'Wait until the current operation finishes before changing agent settings.',
      )
    const { provider = thread.provider, ...data } = settingsSchema
      .extend({ provider: z.enum(['codex', 'claude']).optional() })
      .parse(input)
    // A provider session can't move to another agent, so switching is only allowed before
    // the first message.
    if (provider !== thread.provider && (thread.messages.length || thread.sessionId))
      throw new HttpError(409, 'Start a new thread to use a different agent.')
    this.settingsUpdates.add(id)
    try {
      try {
        await validateEffort(provider, thread.cwd, data)
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid effort level.')
      }
      const previous = {
        provider: thread.provider,
        model: thread.model,
        effort: thread.effort,
        permissionMode: thread.permissionMode,
      }
      Object.assign(thread, data, { provider })
      try {
        await this.store.save()
      } catch {
        Object.assign(thread, previous)
        throw new HttpError(500, 'Could not save agent settings.')
      }
      this.notify()
      return thread
    } finally {
      this.settingsUpdates.delete(id)
    }
  }
  async send(id: string, input: unknown) {
    const { text, attachments: requested } = promptSchema.parse(input)
    const thread = this.get(id)
    let attachments
    try {
      attachments = await this.uploads.resolve(requested)
    } catch (error) {
      if (error instanceof UploadError) throw new HttpError(400, error.message)
      throw error
    }
    if (this.persistenceError) throw new HttpError(500, this.persistenceError)
    if (this.settingsUpdates.has(id))
      throw new HttpError(409, 'Agent settings are still saving. Try sending again.')
    if (this.runs.has(id)) throw new HttpError(409, 'This thread is already working.')
    const previous = structuredClone(thread)
    const now = new Date().toISOString()
    thread.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      text,
      createdAt: now,
      ...(attachments.length ? { attachments } : {}),
    })
    if (thread.title === 'New thread')
      thread.title = text.slice(0, 60) || attachments[0]?.name.slice(0, 60) || 'Image'
    thread.status = 'starting'
    thread.updatedAt = now
    thread.startedAt = now
    thread.completedAt = undefined
    thread.error = undefined
    thread.activities = []
    thread.approvals = []
    const controller = new AbortController()
    const approvals = new Map<string, (allow: boolean) => void>()
    const run: Run = { controller, approvals, done: Promise.resolve() }
    // Reserve before any I/O to reject concurrent submissions.
    this.runs.set(id, run)
    try {
      await this.store.save()
    } catch {
      this.runs.delete(id)
      this.store.threads.set(id, previous)
      throw new HttpError(500, 'Could not save the message.')
    }
    this.notify()
    const images = attachments.map((item) => ({
      path: this.uploads.imagePath(item.id),
      mimeType: item.mimeType,
    }))
    run.done = this.execute(thread, text, images, run)
    return { accepted: true }
  }
  private async execute(thread: Thread, prompt: string, images: PromptImage[], run: Run) {
    const touch = () => {
      thread.updatedAt = new Date().toISOString()
      this.changed()
    }
    const working = () => {
      if (!thread.approvals.length) thread.status = 'working'
    }
    try {
      await this.runners[thread.provider]({
        thread,
        prompt,
        images,
        signal: run.controller.signal,
        session: (id) => {
          thread.sessionId = id
          working()
          touch()
        },
        text: (id, text, replace) => {
          const messageId = `${thread.provider}:${id}`
          const existing = thread.messages.find((message) => message.id === messageId)
          if (existing) existing.text = replace ? text : existing.text + text
          else
            thread.messages.push({
              id: messageId,
              role: 'assistant',
              text,
              createdAt: new Date().toISOString(),
            })
          working()
          touch()
        },
        activity: (activity) => {
          const index = thread.activities.findIndex((item) => item.id === activity.id)
          if (index < 0) thread.activities.push(activity)
          else {
            const old = thread.activities[index]
            thread.activities[index] = {
              ...old,
              ...activity,
              label: activity.label === 'Tool' ? old.label : activity.label,
              detail: activity.detail ?? old.detail,
            }
          }
          working()
          touch()
        },
        approve: (approval) =>
          new Promise<boolean>((resolve, reject) => {
            if (run.controller.signal.aborted) {
              reject(new Error('Turn stopped.'))
              return
            }
            thread.approvals.push(approval)
            thread.status = 'waiting'
            run.approvals.set(approval.id, resolve)
            touch()
          }),
      })
      thread.status = run.controller.signal.aborted ? 'interrupted' : 'completed'
    } catch (error) {
      thread.status = run.controller.signal.aborted ? 'interrupted' : 'failed'
      if (!run.controller.signal.aborted)
        thread.error = error instanceof Error ? error.message : 'The provider failed.'
    } finally {
      for (const resolve of run.approvals.values()) resolve(false)
      run.approvals.clear()
      thread.approvals = []
      thread.activities = thread.activities.map((activity) =>
        activity.status === 'running'
          ? { ...activity, status: thread.status === 'completed' ? 'completed' : 'failed' }
          : activity,
      )
      thread.completedAt = new Date().toISOString()
      touch()
      this.runs.delete(thread.id)
      try {
        await this.store.save()
      } catch {
        this.persistenceError =
          'Could not save conversations. Check disk space and permissions, then restart the server.'
      }
      this.notify()
    }
  }
  approve(id: string, approvalId: string, allow: boolean) {
    const thread = this.get(id),
      run = this.runs.get(id),
      resolve = run?.approvals.get(approvalId)
    if (!run || !resolve) throw new HttpError(409, 'This approval is no longer pending.')
    run.approvals.delete(approvalId)
    thread.approvals = thread.approvals.filter((item) => item.id !== approvalId)
    thread.status = thread.approvals.length ? 'waiting' : 'working'
    resolve(allow)
    this.changed()
    return { ok: true }
  }
  async stop(id: string) {
    this.get(id)
    const run = this.runs.get(id)
    if (run) {
      run.controller.abort()
      for (const resolve of run.approvals.values()) resolve(false)
      run.approvals.clear()
      await run.done
    }
    return { ok: true }
  }
  async close() {
    await Promise.all([...this.runs.keys()].map((id) => this.stop(id)))
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.store.save()
  }
  // The current git branch of a thread's project folder, or null when it isn't a git repo.
  // Runs git directly (no shell) and only in the thread's own folder.
  async gitInfo(id: string): Promise<{ branch: string | null; detached?: boolean }> {
    const { cwd } = this.get(id)
    try {
      const { stdout } = await exec(
        'git',
        ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
        {
          timeout: 3_000,
        },
      )
      return { branch: stdout.trim() || null }
    } catch {
      // Not on a branch: either a detached HEAD or not a repository at all.
      try {
        const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], {
          timeout: 3_000,
        })
        return { branch: stdout.trim() || null, detached: true }
      } catch {
        return { branch: null }
      }
    }
  }
  // Uncommitted changes in a thread's project: tracked files against HEAD plus new untracked
  // files. git runs without a shell, in the thread's own folder, with output caps.
  async diff(id: string): Promise<DiffResult> {
    const { cwd } = this.get(id)
    const git = (args: string[], maxBuffer = 8 * 1024 * 1024) =>
      exec('git', args, { cwd, timeout: 10_000, maxBuffer })
    try {
      await git(['rev-parse', '--is-inside-work-tree'])
    } catch {
      return { repo: false, files: [], truncated: false }
    }
    // A repository with no commits yet diffs against the empty tree.
    const base = await git(['rev-parse', '--verify', '--quiet', 'HEAD'])
      .then(() => 'HEAD')
      .catch(() => '4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    let truncated = false
    const diffArgs = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames']
    let output = ''
    try {
      output = (await git(['diff', ...diffArgs, base, '--'])).stdout
    } catch (error) {
      // Over the buffer cap: show what fit and say the rest was cut.
      const partial = (error as { stdout?: string }).stdout
      if (!partial) throw new HttpError(500, 'Could not read changes from git.')
      output = partial
      truncated = true
    }
    const files: DiffFile[] = parseDiff(output)
    const { stdout: untracked } = await git(['ls-files', '--others', '--exclude-standard', '-z'])
    const paths = untracked.split('\0').filter(Boolean)
    if (paths.length > 100) truncated = true
    for (const path of paths.slice(0, 100)) {
      const size = await stat(join(cwd, path)).then(
        (info) => info.size,
        () => 0,
      )
      if (size > 512 * 1024) {
        files.push({ path, status: 'added', additions: 0, deletions: 0, binary: true, hunks: [] })
        continue
      }
      // --no-index exits with 1 when the files differ; the diff is still on stdout.
      const result = await git(['diff', ...diffArgs, '--no-index', '--', '/dev/null', path]).catch(
        (error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }),
      )
      files.push(...parseDiff(result.stdout))
    }
    return { repo: true, files, truncated }
  }
  async rename(id: string, input: unknown) {
    const { title } = z.object({ title: z.string().trim().min(1).max(120) }).parse(input)
    const thread = this.get(id)
    const previous = thread.title
    // Renaming only touches the label, so it is allowed while the agent works.
    thread.title = title
    try {
      await this.store.save()
    } catch {
      thread.title = previous
      throw new HttpError(500, 'Could not rename the thread.')
    }
    this.notify()
    return thread
  }
  async remove(id: string) {
    const thread = this.get(id)
    if (isActive(thread.status) || this.runs.has(id) || this.settingsUpdates.has(id))
      throw new HttpError(409, 'Stop the agent before deleting this thread.')
    this.store.threads.delete(id)
    try {
      await this.store.save()
    } catch {
      this.store.threads.set(id, thread)
      throw new HttpError(500, 'Could not delete the thread.')
    }
    this.notify()
    return { ok: true }
  }
}
const globals = globalThis as typeof globalThis & { t3MiniService?: Promise<AgentService> }
export function getService() {
  return (globals.t3MiniService ??= (async () => {
    const store = new ThreadStore(defaultStorePath())
    await store.load()
    const service = new AgentService(store)
    await service.projectStore.load()
    return service
  })())
}
