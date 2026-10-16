import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  isActive,
  editableMessage,
  type Bootstrap,
  type GitInfo,
  type Message,
  type ProjectSummary,
  type Provider,
  type Thread,
  type ThreadSummary,
} from '../types'
import { ProjectStore, ThreadStore, defaultStorePath, projectStorePath } from './store'
import { UploadError, Uploads, attachmentSchema } from './uploads'
import { ToolError } from './tools/types'
import { parseDiff, type DiffFile, type DiffResult } from '../diff'
import { openInVSCode, vscodeAvailable } from './editor'
import { githubBranchUrl, githubRepoUrl } from './github'
import { commonWords, extractKeyterms } from './keyterms'
import { titleWriter, type TitleWriter } from './titles'

// No AI titles unless a writer is given (the app's real service gets one; tests don't).
const noTitles: TitleWriter = {
  claudeSession: async () => undefined,
  claude: async () => undefined,
  codex: async () => undefined,
  nameCodexThread: async () => {},
}
import { ProcessManager } from './processes'
import { runCodex } from './providers/codex'
import { runClaude } from './providers/claude'
import { providerExecutable } from './cli-updates'
import {
  rewindRefused,
  type PromptImage,
  type ProviderContext,
  type Runner,
  type Steer,
} from './providers/types'
import { defaultPermission } from '../agent-settings'
import { settingsSchema } from './provider-settings'
import { validateEffort } from './models'

export class HttpError extends Error {
  readonly name = 'HttpError'
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
const projectNameSchema = projectSchema.extend({ name: z.string().trim().max(80) })
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
// What a thread's tools may do with processes: only its own project's, started inside it.
function projectProcesses(manager: ProcessManager, thread: Thread) {
  const own = (id: string) => {
    const info = manager.get(id)
    if (!info || info.project !== thread.cwd) throw new ToolError(`No process with id ${id}.`)
    return info
  }
  return {
    list: () => manager.list(thread.cwd),
    start: async (input: { name: string; command: string; cwd?: string }) => {
      const folder = input.cwd ? resolve(thread.cwd, input.cwd) : thread.cwd
      const inside = relative(thread.cwd, folder)
      if (inside.startsWith('..') || isAbsolute(inside))
        throw new ToolError('Processes can only start inside the project folder.')
      try {
        return manager.start({ ...input, cwd: folder, project: thread.cwd, threadId: thread.id })
      } catch (error) {
        throw new ToolError(error instanceof Error ? error.message : 'Could not start the process.')
      }
    },
    logs: (id: string, lines?: number) => {
      own(id)
      return manager.logs(id, lines) ?? ''
    },
    stop: async (id: string) => manager.stop(own(id).id),
    restart: async (id: string) => manager.restart(own(id).id),
  }
}
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
  // Pending approvals and questions: resolved with yes/no, or a question's answers.
  approvals: Map<string, (answer: boolean | Record<string, string>) => void>
  done: Promise<void>
  // Set by the provider once the live run can take more messages.
  steer?: Steer
  // Messages sent mid-turn that the provider couldn't take; they run next.
  queued: { messageId: string; text: string; images: PromptImage[] }[]
  // The message that started this turn (not a batch of queued ones), which gets a checkpoint.
  messageId?: string
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
    readonly processes = new ProcessManager(),
    // Writes AI titles. Off unless given (tests never call a model); the app passes the real one.
    readonly titles: TitleWriter = noTitles,
  ) {
    // Process status changes (started, URL found, exited) go out with the live updates.
    processes.subscribe(() => this.notify())
  }
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
        ...(project.name ? { name: project.name } : {}),
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
  // Changes the name shown for a project; an empty name goes back to the folder name. Only the
  // label changes: the folder, its path, and its threads stay as they are.
  async renameProject(input: unknown) {
    const { path, name } = projectNameSchema.parse(input)
    const saved = this.projectStore.projects.get(path)
    if (!saved && ![...this.store.threads.values()].some((thread) => thread.cwd === path))
      throw new HttpError(404, 'Project not found.')
    // A folder known only through its threads gets saved as a project to hold the name.
    const project = saved ?? { path, addedAt: new Date().toISOString() }
    const previous = { ...project }
    if (name) project.name = name
    else delete project.name
    this.projectStore.projects.set(path, project)
    try {
      await this.projectStore.save()
    } catch {
      if (saved) this.projectStore.projects.set(path, previous)
      else this.projectStore.projects.delete(path)
      throw new HttpError(500, 'Could not rename the project.')
    }
    this.notify()
    return this.projects().find((item) => item.path === path)!
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
      processes: this.processes.list(),
      persistenceError: this.persistenceError,
    }
  }
  async bootstrap(): Promise<Bootstrap> {
    const check = async (provider: Provider) => {
      try {
        const { stdout } = await exec(providerExecutable(provider), ['--version'], {
          timeout: 5_000,
        })
        return { installed: true, version: stdout.trim().split('\n')[0] }
      } catch {
        return { installed: false }
      }
    }
    const [codex, claude, vscode] = await Promise.all([
      check('codex'),
      check('claude'),
      vscodeAvailable(),
    ])
    return {
      threads: this.list(),
      projects: this.projects(),
      providers: { codex, claude },
      editors: { vscode },
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
    const firstMessage = thread.title === 'New thread'
    if (firstMessage) {
      thread.title = text.slice(0, 60) || attachments[0]?.name.slice(0, 60) || 'Image'
      thread.titleSource = 'message'
    }
    try {
      await this.startTurn(thread, text, images, message.id)
    } catch (error) {
      this.store.threads.set(id, previous)
      throw error
    }
    // Codex doesn't name threads, so one is written right away; Claude's arrives with its reply.
    if (firstMessage && thread.provider === 'codex') void this.autoTitle(id)
    return { accepted: true }
  }
  // Replaces the last message of a stopped or failed turn and runs it again. The agent's memory
  // is rewound to before that turn (see TurnCheckpoint); files it changed stay changed.
  async edit(id: string, input: unknown) {
    const { messageId } = z.object({ messageId: z.string().min(1).max(200) }).parse(input)
    const { text, attachments: requested } = promptSchema.parse(input)
    const thread = this.get(id)
    if (this.runs.has(id)) throw new HttpError(409, 'Stop the agent before editing a message.')
    const target = editableMessage(thread)
    if (!target || target.id !== messageId)
      throw new HttpError(409, 'Only your last message of a stopped or failed turn can be edited.')
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
    const previous = structuredClone(thread)
    const checkpoint = target.turn!
    thread.messages = thread.messages.slice(0, thread.messages.indexOf(target))
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
    }
    thread.messages.push(message)
    if (checkpoint.fresh) {
      // It was the session's first turn: start over with a new session.
      thread.sessionId = undefined
      thread.claudeEntry = undefined
      thread.rewind = undefined
    } else {
      thread.rewind = checkpoint
      if (checkpoint.claudeResumeAt) thread.claudeEntry = checkpoint.claudeResumeAt
    }
    try {
      await this.startTurn(
        thread,
        text,
        attachments.map((item) => ({
          path: this.uploads.imagePath(item.id),
          mimeType: item.mimeType,
        })),
        message.id,
      )
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
      } else await this.startTurn(thread, message.text, images, message.id)
    }
    this.changed()
    return { accepted: true, steered }
  }
  // Starts a turn for messages already in the thread.
  private async startTurn(thread: Thread, text: string, images: PromptImage[], messageId?: string) {
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
    const approvals = new Map<string, (answer: boolean | Record<string, string>) => void>()
    const run: Run = { controller, approvals, done: Promise.resolve(), queued: [], messageId }
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
    // The message that started this turn records how to take the turn back (for editing it
    // after a stop). Claude: resume from the conversation's latest entry and drop this prompt.
    const started = run.messageId
      ? thread.messages.find((message) => message.id === run.messageId)
      : undefined
    const promptId = crypto.randomUUID()
    if (started)
      started.turn =
        thread.provider === 'codex'
          ? undefined // Filled in once Codex reports the turn's id.
          : !thread.sessionId
            ? { fresh: true, claudePrompt: promptId }
            : thread.claudeEntry
              ? { claudeResumeAt: thread.claudeEntry, claudePrompt: promptId }
              : undefined
    const context: ProviderContext = {
      thread,
      prompt,
      images,
      promptId,
      rewind: thread.rewind,
      rewound: (ok) => {
        thread.rewind = undefined
        if (!ok && started) started.rewindFailed = true
        touch()
      },
      entry: (id) => {
        thread.claudeEntry = id
      },
      turnStarted: (turnId) => {
        if (started) started.turn = { codexTurn: turnId }
      },
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
      tools: {
        cwd: thread.cwd,
        processes: projectProcesses(this.processes, thread),
        saveImage: (bytes) => this.uploads.saveImage(bytes),
        rename: async (title) => (await this.rename(thread.id, { title })).title,
        // A tool's content joins the agent's latest reply in this turn; if the agent hasn't
        // written anything since the user's message, it gets a reply of its own.
        attach: (block) => {
          const last = thread.messages.at(-1)
          if (last?.role === 'assistant') last.blocks = [...(last.blocks ?? []), block]
          else
            thread.messages.push({
              id: `tool:${crypto.randomUUID()}`,
              role: 'assistant',
              text: '',
              createdAt: new Date().toISOString(),
              blocks: [block],
            })
          touch()
        },
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
          run.approvals.set(approval.id, (answer) => resolve(answer !== false))
          touch()
        }),
      // A question waits like an approval, but resolves with your answers (null if skipped).
      ask: ({ id, title, questions }) =>
        new Promise<Record<string, string> | null>((resolve, reject) => {
          if (run.controller.signal.aborted) {
            reject(new Error('Turn stopped.'))
            return
          }
          thread.approvals.push({ id, title, detail: '', questions })
          thread.status = 'waiting'
          run.approvals.set(id, (answer) => resolve(typeof answer === 'object' ? answer : null))
          touch()
        }),
      background: (tasks) => {
        thread.background = tasks.length ? tasks : undefined
        touch()
      },
    }
    try {
      try {
        await this.runners[thread.provider](context)
      } catch (error) {
        // Claude refused the rewind (the dropped range held something unexpected): run the
        // edit as a plain follow-up instead, keeping the old turn in its memory.
        if (
          !context.rewind ||
          run.controller.signal.aborted ||
          !(error instanceof Error && error.message.includes(rewindRefused))
        )
          throw error
        context.rewound?.(false)
        if (started) started.turn = undefined
        await this.runners[thread.provider]({ ...context, rewind: undefined })
      }
      // A finished run has used up the rewind it was given, whether or not it said so.
      if (context.rewind && thread.rewind === context.rewind) thread.rewind = undefined
      thread.status = run.controller.signal.aborted ? 'interrupted' : 'completed'
    } catch (error) {
      thread.status = run.controller.signal.aborted ? 'interrupted' : 'failed'
      if (!run.controller.signal.aborted)
        thread.error = error instanceof Error ? error.message : 'The provider failed.'
    } finally {
      for (const resolve of run.approvals.values()) resolve(false)
      run.approvals.clear()
      thread.approvals = []
      thread.background = undefined
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
      // Claude has written its title by now (if not, the next turn tries again).
      if (thread.provider === 'claude' && thread.titleSource === 'message' && thread.sessionId)
        void this.autoTitle(thread.id)
    }
  }
  // Replaces the automatic first-message title with an AI one (see titles.ts): Claude's own
  // session title, or a quick Luna call for Codex. Never touches a title you or the agent set.
  private titling = new Set<string>()
  private async autoTitle(id: string) {
    const thread = this.store.threads.get(id)
    if (!thread || thread.titleSource !== 'message' || this.titling.has(id)) return
    this.titling.add(id)
    try {
      const title =
        thread.provider === 'claude'
          ? thread.sessionId
            ? await this.titles.claudeSession(thread.sessionId, thread.cwd)
            : undefined
          : await this.titles.codex(this.conversation(thread))
      // Renamed meanwhile (or deleted)? Then keep that.
      const current = this.store.threads.get(id)
      if (title && current?.titleSource === 'message') this.applyTitle(current, title)
    } catch {
      // The first-message title stays.
    } finally {
      this.titling.delete(id)
    }
  }
  // What a title is written from: your first message and the latest reply.
  private conversation(thread: Thread) {
    const first = thread.messages.find((message) => message.role === 'user')
    const reply = [...thread.messages].reverse().find((message) => message.role === 'assistant')
    return [
      `User: ${first?.text || thread.title}`,
      reply?.text ? `Assistant (latest reply): ${reply.text.slice(0, 1000)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  private applyTitle(thread: Thread, title: string) {
    thread.title = title
    thread.titleSource = 'ai'
    this.changed()
    // Codex's own apps show the same name (best effort).
    if (thread.provider === 'codex' && thread.sessionId)
      void this.titles.nameCodexThread(thread.sessionId, title).catch(() => {})
  }
  // "Regenerate title": a fresh title from the conversation (Haiku for Claude, Luna for Codex).
  async regenerateTitle(id: string) {
    const thread = this.get(id)
    if (!thread.messages.some((message) => message.role === 'user'))
      throw new HttpError(409, 'Send a message first.')
    let title: string | undefined
    try {
      title = await (thread.provider === 'claude' ? this.titles.claude : this.titles.codex)(
        this.conversation(thread),
      )
    } catch {
      title = undefined
    }
    if (!title) throw new HttpError(502, 'Couldn’t write a title right now. Try again.')
    this.applyTitle(thread, title)
    return thread
  }
  // Answers an approval (allow or decline), or a question (allow with answers, or skip).
  approve(id: string, approvalId: string, allow: boolean, answers?: Record<string, string>) {
    const thread = this.get(id),
      run = this.runs.get(id),
      resolve = run?.approvals.get(approvalId)
    if (!run || !resolve) throw new HttpError(409, 'This approval is no longer pending.')
    run.approvals.delete(approvalId)
    thread.approvals = thread.approvals.filter((item) => item.id !== approvalId)
    thread.status = thread.approvals.length ? 'waiting' : 'working'
    resolve(allow ? (answers ?? true) : false)
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
    await this.processes.stopAll()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.store.save()
  }
  // The current git branch of a thread's project folder, or null when it isn't a git repo,
  // plus a GitHub link when the remote is on GitHub. Runs git directly (no shell) and only in
  // the thread's own folder.
  // Unusual words from the agent's last two replies, to help dictation spell them (see
  // keyterms.ts for what is and isn't sent). Unknown threads simply get none.
  async dictationKeyterms(id: string) {
    const thread = this.store.threads.get(id)
    const replies = (thread?.messages ?? [])
      .filter((message) => message.role === 'assistant' && message.text)
      .slice(-2)
      .map((message) => message.text)
    return replies.length ? extractKeyterms(replies, await commonWords()) : []
  }
  async gitInfo(id: string): Promise<GitInfo> {
    const { cwd } = this.get(id)
    const git = async (args: string[]) =>
      (await exec('git', ['-C', cwd, ...args], { timeout: 3_000 })).stdout.trim()
    const optional = (args: string[]) => git(args).catch(() => '')
    let branch: string
    let detached = false
    try {
      branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    } catch {
      // Not on a branch: either a detached HEAD or not a repository at all.
      try {
        branch = await git(['rev-parse', '--short', 'HEAD'])
        detached = true
      } catch {
        return { branch: null }
      }
    }
    if (!branch) return { branch: null }
    // Link to the branch on the remote it tracks; without one (or detached), the repository
    // on origin, since the branch may not exist on GitHub.
    const upstream = detached ? '' : await optional(['config', '--get', `branch.${branch}.remote`])
    const tracked = upstream && upstream !== '.'
    const remote = tracked ? upstream : 'origin'
    const merge = tracked ? await optional(['config', '--get', `branch.${branch}.merge`]) : ''
    const repo = remote.startsWith('-')
      ? null
      : githubRepoUrl(await optional(['remote', 'get-url', remote]))
    const url =
      repo && merge.startsWith('refs/heads/')
        ? githubBranchUrl(repo, merge.slice('refs/heads/'.length))
        : repo
    return { branch, ...(detached ? { detached } : {}), ...(url ? { url } : {}) }
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
  // Opens the thread's own project folder in VS Code (never a client-supplied path).
  async openInEditor(id: string) {
    const { cwd } = this.get(id)
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error()
    } catch {
      throw new HttpError(400, 'This project folder no longer exists.')
    }
    try {
      await openInVSCode(cwd)
    } catch {
      throw new HttpError(500, 'Could not open VS Code. Check that it is installed.')
    }
    return { ok: true }
  }
  async rename(id: string, input: unknown) {
    const { title } = z.object({ title: z.string().trim().min(1).max(120) }).parse(input)
    const thread = this.get(id)
    const previous = { title: thread.title, titleSource: thread.titleSource }
    // Renaming only touches the label, so it is allowed while the agent works. A name you (or
    // the agent) chose is never replaced by an automatic title.
    thread.title = title
    thread.titleSource = 'custom'
    try {
      await this.store.save()
    } catch {
      Object.assign(thread, previous)
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
    const service = new AgentService(store, undefined, undefined, undefined, undefined, titleWriter)
    await service.projectStore.load()
    return service
  })())
}
