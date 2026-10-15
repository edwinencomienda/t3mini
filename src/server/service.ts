import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  isActive,
  type Bootstrap,
  type Message,
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
import type { PromptImage, Runner, Steer } from './providers/types'
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
  serviceTier: settingsSchema.shape.serviceTier,
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
// Caps for the Changes panel.
const maxDiffFiles = 200
const maxDiffLines = 3000
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
  // Set by the provider once the live run can take more messages.
  steer?: Steer
  // Messages sent mid-turn that the provider couldn't take; they run next.
  queued: { messageId: string; text: string; images: PromptImage[] }[]
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
      ...(data.serviceTier ? { serviceTier: data.serviceTier } : {}),
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
        serviceTier: thread.serviceTier,
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
    const images = attachments.map((item) => ({
      path: this.uploads.imagePath(item.id),
      mimeType: item.mimeType,
    }))
    const message = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      text,
      createdAt: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
    }
    const running = this.runs.get(id)
    if (running) return this.steer(thread, running, message, images)
    const previous = structuredClone(thread)
    thread.messages.push(message)
    if (thread.title === 'New thread')
      thread.title = text.slice(0, 60) || attachments[0]?.name.slice(0, 60) || 'Image'
    try {
      await this.startTurn(thread, text, images)
    } catch (error) {
      this.store.threads.set(id, previous)
      throw error
    }
    return { accepted: true }
  }
  // A message sent while the agent works: hand it to the live run if the provider can take it,
  // otherwise queue it to run as soon as the current turn ends.
  private async steer(
    thread: Thread,
    run: Run,
    message: Message,
    images: PromptImage[],
  ): Promise<{ accepted: true; steered: boolean }> {
    thread.messages.push(message)
    thread.updatedAt = message.createdAt
    this.notify()
    let steered = false
    try {
      steered = (await run.steer?.({ prompt: message.text, images })) ?? false
    } catch {
      steered = false
    }
    if (!steered && run.controller.signal.aborted) {
      // Stopped while we were handing it over: stop means stop, so never start another turn.
      message.unsent = true
    } else if (!steered) {
      // Queue on whichever run is active now (the turn may have ended and a queued follow-up
      // started meanwhile); with none running, this message starts the next turn itself.
      const current = this.runs.get(thread.id)
      if (current?.controller.signal.aborted) message.unsent = true
      else if (current) {
        message.queued = true
        current.queued.push({ messageId: message.id, text: message.text, images })
      } else await this.startTurn(thread, message.text, images)
    }
    this.changed()
    return { accepted: true, steered }
  }
  // Starts a turn for messages already in the thread.
  private async startTurn(thread: Thread, text: string, images: PromptImage[]) {
    const id = thread.id
    if (this.runs.has(id)) throw new HttpError(409, 'This thread is already working.')
    const now = new Date().toISOString()
    thread.status = 'starting'
    thread.updatedAt = now
    thread.startedAt = now
    thread.completedAt = undefined
    thread.error = undefined
    thread.activities = []
    thread.approvals = []
    const controller = new AbortController()
    const approvals = new Map<string, (allow: boolean) => void>()
    const run: Run = { controller, approvals, done: Promise.resolve(), queued: [] }
    // Reserve before any I/O; later messages steer this run instead of starting another.
    this.runs.set(id, run)
    try {
      await this.store.save()
    } catch {
      this.runs.delete(id)
      throw new HttpError(500, 'Could not save the message.')
    }
    this.notify()
    run.done = this.execute(thread, text, images, run)
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
              summary: activity.summary ?? old.summary,
              detail: activity.detail ?? old.detail,
              output: activity.output ?? old.output,
            }
          }
          working()
          touch()
        },
        onSteer: (handler) => {
          run.steer = handler
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
      // Messages queued during the turn go out together as the next turn, unless it was stopped.
      const queued = run.queued
      for (const item of queued) {
        const message = thread.messages.find((entry) => entry.id === item.messageId)
        if (!message) continue
        delete message.queued
        if (run.controller.signal.aborted) message.unsent = true
      }
      if (queued.length && !run.controller.signal.aborted)
        void this.startTurn(
          thread,
          queued
            .map((item) => item.text)
            .filter(Boolean)
            .join('\n\n'),
          queued.flatMap((item) => item.images),
        ).catch((error: unknown) => {
          thread.error = error instanceof Error ? error.message : 'Could not send queued messages.'
          this.notify()
        })
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
      return { repo: false, files: [], truncated: false, totalFiles: 0 }
    }
    // A repository with no commits yet diffs against the empty tree.
    const base = await git(['rev-parse', '--verify', '--quiet', 'HEAD'])
      .then(() => 'HEAD')
      .catch(() => '4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    const diffArgs = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames']
    // List changed files first (cheap), then diff only the first maxDiffFiles of them, so a huge
    // refactor never sends thousands of file diffs to the browser.
    const { stdout: numstat } = await git(['diff', '--numstat', '-z', '--find-renames', base, '--'])
    const tracked: string[][] = []
    const entries = numstat.split('\0')
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!
      if (!entry) continue
      const path = entry.split('\t')[2]
      // Renames are "adds\tdels\t" followed by the old and new paths as separate entries.
      if (path) tracked.push([path])
      else tracked.push([entries[++index]!, entries[++index]!].filter(Boolean))
    }
    const { stdout: untrackedOutput } = await git([
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ])
    const untracked = untrackedOutput.split('\0').filter(Boolean)
    const totalFiles = tracked.length + untracked.length
    const shownTracked = tracked.slice(0, maxDiffFiles)
    const shownUntracked = untracked.slice(0, Math.max(0, maxDiffFiles - shownTracked.length))
    let truncated = shownTracked.length + shownUntracked.length < totalFiles
    const files: DiffFile[] = []
    if (shownTracked.length) {
      let output = ''
      try {
        output = (await git(['diff', ...diffArgs, base, '--', ...shownTracked.flat()])).stdout
      } catch (error) {
        // Over the buffer cap: show what fit and say the rest was cut.
        const partial = (error as { stdout?: string }).stdout
        if (!partial) throw new HttpError(500, 'Could not read changes from git.')
        output = partial
        truncated = true
      }
      files.push(...parseDiff(output))
    }
    // A new file's diff is every line added, so build it from the file itself (in parallel,
    // no git process per file).
    files.push(
      ...(await Promise.all(
        shownUntracked.map(async (path): Promise<DiffFile> => {
          const added = { path, status: 'added' as const, deletions: 0 }
          try {
            const info = await stat(join(cwd, path))
            if (!info.isFile() || info.size > 512 * 1024)
              return { ...added, additions: 0, binary: true, hunks: [] }
            const bytes = await readFile(join(cwd, path))
            // A NUL byte early on means binary, the same check git uses.
            if (bytes.subarray(0, 8000).includes(0))
              return { ...added, additions: 0, binary: true, hunks: [] }
            const lines = bytes.toString('utf8').split('\n')
            if (lines.at(-1) === '') lines.pop()
            return {
              ...added,
              additions: lines.length,
              binary: false,
              hunks: lines.length
                ? [
                    {
                      header: `@@ -0,0 +1,${lines.length} @@`,
                      lines: lines.map((text, index) => ({
                        type: 'add' as const,
                        new: index + 1,
                        text: text.replace(/\r$/, ''),
                      })),
                    },
                  ]
                : [],
            }
          } catch {
            return { ...added, additions: 0, binary: true, hunks: [] }
          }
        }),
      )),
    )
    // One huge file (a lockfile, generated code) shouldn't freeze the panel: keep its counts,
    // drop its lines.
    for (const file of files)
      if (file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) > maxDiffLines) {
        file.hunks = []
        file.tooLarge = true
      }
    return { repo: true, files, truncated, totalFiles }
  }
  // A cheap fingerprint of the project's uncommitted state, so the client can poll often and
  // fetch the full diff only when something changed. Covers edits to already-modified files
  // (mtime/size), new or deleted files (status), and commits (HEAD).
  async diffVersion(id: string): Promise<{ version: string | null }> {
    const { cwd } = this.get(id)
    const git = (args: string[]) =>
      exec('git', args, { cwd, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 })
    try {
      const [{ stdout: status }, head] = await Promise.all([
        git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(
          (result) => result.stdout.trim(),
          () => '',
        ),
      ])
      const hash = createHash('sha1').update(head).update('\0').update(status)
      // Entries are "XY path"; renames add the original path as a separate entry.
      const paths = status
        .split('\0')
        .filter((entry) => entry.length > 3 && entry[2] === ' ')
        .map((entry) => entry.slice(3))
        .slice(0, 2000)
      const stats = await Promise.all(
        paths.map((path) =>
          stat(join(cwd, path)).then(
            (info) => `${path}:${info.mtimeMs}:${info.size}`,
            () => `${path}:gone`,
          ),
        ),
      )
      for (const line of stats) hash.update(line).update('\0')
      return { version: hash.digest('hex') }
    } catch {
      return { version: null }
    }
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
