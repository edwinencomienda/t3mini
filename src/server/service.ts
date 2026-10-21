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
  type Activity,
  type Bootstrap,
  type GitInfo,
  type MessageMatch,
  type ThreadGlance,
  type PullRequest,
  type Message,
  type Project,
  type ProjectSummary,
  type Provider,
  type Thread,
  type ThreadSummary,
} from '../types'
import {
  ProjectStore,
  ThreadStore,
  defaultStorePath,
  projectStorePath,
  UiStore,
  uiStorePath,
} from './store'
import { UploadError, Uploads, attachmentSchema, isImageId } from './uploads'
import { BrowserStats } from './browser-stats'
import { describeThread, projectLabel, threadIdFrom } from './shared-thread'
import { ToolError, type ThreadControl } from './tools/types'
import { parseDiff, type DiffFile, type DiffResult } from '../diff'
import { openInVSCode, vscodeAvailable } from './editor'
import { githubBranchUrl, githubPullUrl, githubRepoUrl, pullRequestFor } from './github'
import { commonWords, extractKeyterms } from './keyterms'
import { titleWriter, type TitleWriter } from './titles'

// No AI titles unless a writer is given (the app's real service gets one; tests don't).
const noTitles: TitleWriter = {
  claudeSession: async () => undefined,
  claude: async () => undefined,
  codex: async () => undefined,
  nameCodexThread: async () => {},
}
import { BrowserManager } from './browser'
import { TabRegistry } from './tabs'
import { uiChange } from './ui-settings'
import { ProjectIcons } from './project-icons'
import { ProcessManager } from './processes'
import { chatsRoot, createChatFolder, ensureChatsRoot, removeChatFolder } from './chats'
import {
  createWorktree,
  isWorktreeError,
  removeWorktree,
  repoRoot,
  worktreeChanges,
  worktreeFolder,
  worktreeProgress,
} from './worktrees'
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
import { cachedModels, checkEffort, getModels, validateEffort, warmModels } from './models'

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
  // The project folder, or noProject for a thread without one (a chat, see chats.ts).
  cwd: z.string().trim().default(''),
  noProject: z.boolean().default(false),
  model: settingsSchema.shape.model.default(''),
  effort: settingsSchema.shape.effort.default(''),
  serviceTier: settingsSchema.shape.serviceTier,
  permissionMode: settingsSchema.shape.permissionMode.optional(),
})
const projectSchema = z.object({ path: z.string().trim().min(1).max(4096) })
const projectNameSchema = projectSchema.extend({ name: z.string().trim().max(80) })
const projectAvatarSchema = projectSchema.extend({
  avatar: z.enum(['auto', 'letter', 'image']),
  image: z.string().max(100).optional(),
})
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
  ...(thread.unread ? { unread: true } : {}),
  ...(thread.worktree ? { worktreeBranch: thread.worktree.branch } : {}),
  ...(thread.parentId ? { parentId: thread.parentId } : {}),
  ...(thread.chat ? { chat: true } : {}),
  ...(thread.status === 'waiting'
    ? {
        waitingFor: thread.approvals.some((item) => item.questions?.length)
          ? ('question' as const)
          : ('approval' as const),
      }
    : {}),
})
// Orchestration limits: helpers running at once per lead, and turns a lead may start on its own
// from helper reports before you write again (so reports and replies can't loop forever).
const maxRunningHelpers = 5
const maxAutoTurns = 10
// The first message a helper gets: who it works for and that its answer goes back there.
const helperBrief = (lead: Thread, task: string) =>
  `[Task from the lead thread "${lead.title}". Your final answer is sent back to it automatically, ` +
  'so end with a short summary: what you did, what changed (branch, files), and anything left.]' +
  `\n\n${task}`
const agentName = (provider: Provider) => (provider === 'claude' ? 'Claude' : 'Codex')
// Where a thread works: its worktree when it has one, otherwise the project folder.
export const workdir = (thread: Thread) =>
  thread.worktree ? worktreeFolder(thread.worktree) : (thread.chatFolder ?? thread.cwd)
// What a thread's tools may do with processes: only its own project's, started inside the folder
// it works in (its worktree, for a worktree thread).
function projectProcesses(manager: ProcessManager, thread: Thread) {
  const own = (id: string) => {
    const info = manager.get(id)
    if (!info || info.project !== thread.cwd) throw new ToolError(`No process with id ${id}.`)
    return info
  }
  return {
    list: () => manager.list(thread.cwd),
    start: async (input: { name: string; command: string; cwd?: string }) => {
      const home = workdir(thread)
      const folder = input.cwd ? resolve(home, input.cwd) : home
      const inside = relative(home, folder)
      if (inside.startsWith('..') || isAbsolute(inside))
        throw new ToolError('Processes can only start inside the project folder.')
      // Said plainly: a missing folder otherwise surfaces as "spawn /bin/zsh ENOENT".
      const isFolder = await stat(folder)
        .then((info) => info.isDirectory())
        .catch(() => false)
      if (!isFolder)
        throw new ToolError(
          `Folder not found: ${input.cwd} (cwd is relative to the project folder, ${home}). ` +
            'Leave cwd out to run in the project folder.',
        )
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
  // Stopped runs still exiting, by thread (see stop and windDown).
  private winding = new Map<string, Promise<void>>()
  private timer?: NodeJS.Timeout
  private persistenceError?: string
  readonly icons: ProjectIcons
  // Open tabs everywhere, to pick the one that notifies (see tabs.ts).
  readonly tabs = new TabRegistry(() => this.notify())
  // View settings shared by every browser (Group by…).
  readonly ui: UiStore
  // How often agents check UI changes in the browser (Settings → Agents).
  readonly browserStats: BrowserStats
  constructor(
    readonly store: ThreadStore,
    private runners: Record<Provider, Runner> = { codex: runCodex, claude: runClaude },
    readonly projectStore = new ProjectStore(projectStorePath(store.path)),
    readonly uploads = new Uploads(join(dirname(store.path), 'attachments')),
    readonly processes = new ProcessManager(),
    // Writes AI titles. Off unless given (tests never call a model); the app passes the real one.
    readonly titles: TitleWriter = noTitles,
    // The agents' browser sessions (browser_* tools); nothing starts until a tool uses it.
    readonly browsers = new BrowserManager(),
  ) {
    this.ui = new UiStore(uiStorePath(store.path))
    this.browserStats = new BrowserStats(join(dirname(store.path), 'browser-stats.json'))
    // Project icons for the sidebar avatars, looked up in the background.
    this.icons = new ProjectIcons(() => this.notify())
    // Process status changes (started, URL found, exited) go out with the live updates.
    processes.subscribe(() => this.notify())
    // An agent's browser opening, moving to another page, or closing shows in its chip.
    browsers.subscribe(() => this.notify())
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
        lastActiveAt:
          project.lastActiveAt && project.lastActiveAt > project.addedAt
            ? project.lastActiveAt
            : project.addedAt,
        addedAt: project.addedAt,
        threadCount: 0,
        ...(project.avatar ? { avatar: project.avatar } : {}),
        ...(project.image ? { image: project.image } : {}),
      })
    for (const thread of this.store.threads.values()) {
      const sentAt = lastMessageAt(thread)
      const project = projects.get(thread.cwd) ?? {
        path: thread.cwd,
        lastActiveAt: sentAt,
        addedAt: thread.createdAt,
        threadCount: 0,
      }
      project.threadCount++
      if (sentAt > project.lastActiveAt) project.lastActiveAt = sentAt
      // A folder without a saved project counts from its first thread.
      if (!this.projectStore.projects.has(thread.cwd) && thread.createdAt < project.addedAt)
        project.addedAt = thread.createdAt
      projects.set(thread.cwd, project)
    }
    for (const project of projects.values()) if (this.icons.known(project.path)) project.icon = true
    // The chats folder shows as "No project".
    for (const thread of this.store.threads.values()) {
      const project = thread.chat ? projects.get(thread.cwd) : undefined
      if (project) Object.assign(project, { chats: true, name: 'No project' })
    }
    return [...projects.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }
  // A saved project keeps its place in the sidebar after its threads are deleted: it remembers
  // the deleted thread's latest message as its own last activity. Best effort.
  private async keepProjectPlace(thread: Thread) {
    const project = this.projectStore.projects.get(thread.cwd)
    const sentAt = lastMessageAt(thread)
    if (!project || sentAt <= (project.lastActiveAt ?? project.addedAt)) return
    project.lastActiveAt = sentAt
    try {
      await this.projectStore.save()
    } catch {
      // Kept in memory until the next save; only the order is at stake.
    }
  }
  // You've seen a thread (opened it in any browser): it's no longer unread anywhere.
  async markRead(id: string) {
    const thread = this.get(id)
    if (!thread.unread) return { ok: true }
    delete thread.unread
    this.changed()
    return { ok: true }
  }
  // Changes shared view settings (see ui-settings.ts); every open window gets them with the
  // next live update. The music's position is saved often, so on its own it isn't broadcast:
  // a window reads it when it starts the music.
  async updateUi(input: unknown) {
    const change = uiChange.parse(input)
    const previous = { ...this.ui.settings }
    Object.assign(this.ui.settings, change)
    try {
      await this.ui.save()
    } catch {
      this.ui.settings = previous
      throw new HttpError(500, 'Could not save the setting.')
    }
    if (Object.keys(change).some((key) => key !== 'musicPosition')) this.notify()
    return this.ui.settings
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
  // Threads whose messages mention the query (case-insensitive), newest first, one match per
  // thread, with a short excerpt around it. For the command palette's "In messages" results.
  glance(id: string): ThreadGlance {
    const thread = this.get(id)
    const shorten = (text: string | undefined, length: number) => {
      const value = text?.replace(/\s+/g, ' ').trim()
      if (!value) return undefined
      return value.length > length ? `${value.slice(0, length - 1).trimEnd()}…` : value
    }
    const sent = thread.messages.filter((message) => !message.queued && !message.unsent)
    const firstMessage = shorten(sent.find((message) => message.role === 'user')?.text, 160)
    const lastReply = shorten(
      [...sent].reverse().find((message) => message.role === 'assistant')?.text,
      220,
    )
    const waitingOn = thread.status === 'waiting' ? thread.approvals[0]?.title : undefined
    return {
      id: thread.id,
      title: thread.title,
      provider: thread.provider,
      cwd: thread.cwd,
      model: thread.model,
      effort: thread.effort,
      permissionMode: thread.permissionMode,
      ...(thread.serviceTier ? { serviceTier: thread.serviceTier } : {}),
      status: thread.status,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      ...(thread.error ? { error: shorten(thread.error, 160) } : {}),
      messageCount: sent.length,
      ...(firstMessage ? { firstMessage } : {}),
      ...(lastReply ? { lastReply } : {}),
      ...(waitingOn ? { waitingOn: shorten(waitingOn, 120) } : {}),
    }
  }
  searchMessages(input: unknown): MessageMatch[] {
    const query = z.string().trim().min(2).max(200).parse(input).toLowerCase()
    const matches: MessageMatch[] = []
    for (const thread of this.list()) {
      const full = this.store.threads.get(thread.id)
      const message = full?.messages.find((item) => item.text.toLowerCase().includes(query))
      if (!full || !message) continue
      const text = message.text.replace(/\s+/g, ' ')
      const at = text.toLowerCase().indexOf(query)
      const start = Math.max(0, at - 60)
      const end = Math.min(text.length, at + query.length + 80)
      matches.push({
        threadId: full.id,
        title: full.title,
        cwd: full.cwd,
        role: message.role,
        snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
      })
      if (matches.length >= 20) break
    }
    return matches
  }
  // Changes the name shown for a project; an empty name goes back to the folder name. Only the
  // label changes: the folder, its path, and its threads stay as they are.
  async renameProject(input: unknown) {
    const { path, name } = projectNameSchema.parse(input)
    return this.updateProject(path, 'Could not rename the project.', (project) => {
      if (name) project.name = name
      else delete project.name
    })
  }
  // Project settings → Avatar: automatic (its own icon, else its letter), its letter, or an
  // image you uploaded (an existing upload, checked by its id; uploads are PNG, JPEG, GIF, or
  // WebP checked from their bytes, never SVG).
  async setProjectAvatar(input: unknown) {
    const { path, avatar, image } = projectAvatarSchema.parse(input)
    if (avatar === 'image') {
      if (!isImageId(image)) throw new HttpError(400, 'Choose an image first.')
      try {
        if (!(await stat(this.uploads.imagePath(image))).isFile()) throw new Error()
      } catch {
        throw new HttpError(400, 'That image is missing. Choose it again.')
      }
    }
    return this.updateProject(path, 'Could not save the avatar.', (project) => {
      delete project.avatar
      delete project.image
      if (avatar === 'letter') project.avatar = 'letter'
      if (avatar === 'image') Object.assign(project, { avatar: 'image', image })
    })
  }
  private async updateProject(path: string, failure: string, change: (project: Project) => void) {
    const saved = this.projectStore.projects.get(path)
    if (!saved && ![...this.store.threads.values()].some((thread) => thread.cwd === path))
      throw new HttpError(404, 'Project not found.')
    // A folder known only through its threads gets saved as a project to hold the change.
    const project = saved ?? { path, addedAt: new Date().toISOString() }
    const previous = { ...project }
    change(project)
    this.projectStore.projects.set(path, project)
    try {
      await this.projectStore.save()
    } catch {
      if (saved) this.projectStore.projects.set(path, previous)
      else this.projectStore.projects.delete(path)
      throw new HttpError(500, failure)
    }
    this.notify()
    return this.projects().find((item) => item.path === path)!
  }
  // Removes a project from the sidebar. With `threads: true` its threads are deleted too (none
  // may be running); otherwise it must have none. The folder on disk is never touched.
  async removeProject(input: unknown) {
    const { path, threads: withThreads } = projectSchema
      .extend({ threads: z.boolean().default(false) })
      .parse(input)
    const owned = [...this.store.threads.values()].filter((thread) => thread.cwd === path)
    if (owned.length && !withThreads)
      throw new HttpError(409, 'Delete this project’s threads before removing it.')
    // Threads that were just stopped finish exiting first.
    await Promise.all(owned.map((thread) => this.windDown(thread.id)))
    if (
      owned.some(
        (thread) =>
          isActive(thread.status) ||
          this.runs.has(thread.id) ||
          this.settingsUpdates.has(thread.id),
      )
    )
      throw new HttpError(409, 'Stop the running threads in this project first.')
    const project = this.projectStore.projects.get(path)
    if (!project && !owned.length) throw new HttpError(404, 'Project not found.')
    if (owned.length) {
      for (const thread of owned) this.store.threads.delete(thread.id)
      try {
        await this.store.save()
      } catch {
        for (const thread of owned) this.store.threads.set(thread.id, thread)
        throw new HttpError(500, 'Could not delete the project’s threads.')
      }
      for (const thread of owned) void this.browsers.close(thread.id)
    }
    if (project) {
      this.projectStore.projects.delete(path)
      try {
        await this.projectStore.save()
      } catch {
        this.projectStore.projects.set(path, project)
        this.notify()
        throw new HttpError(500, 'Could not remove the project.')
      }
    }
    this.notify()
    const kept = await this.cleanUpWorktrees(owned)
    return {
      ok: true,
      deletedThreads: owned.length,
      ...(kept.length ? { keptWorktrees: kept } : {}),
    }
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
      browsers: this.browsers.list(),
      ui: this.ui.settings,
      activeTab: this.tabs.leader() ?? null,
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
      ui: this.ui.settings,
      threads: this.list(),
      projects: this.projects(),
      providers: { codex, claude },
      editors: { vscode },
      defaultCwd: homedir(),
    }
  }
  async create(input: unknown) {
    const data = createSchema.parse(input)
    // A chat lives in the chats folder ("No project"); so does a thread created there directly
    // (a chat's helper). The folder is only made for a chat.
    const cwd = data.noProject
      ? await ensureChatsRoot().catch(() => {
          throw new HttpError(500, 'Could not create the chats folder.')
        })
      : await resolveFolder(data.cwd)
    const chat = data.noProject || cwd === (await realpath(chatsRoot()).catch(() => null))
    // Creating a thread shouldn't wait for an agent's CLI (~0.3 s to list its models): check
    // the effort against a list already in memory, or create now and check in the background.
    const tuned = Boolean(data.effort || data.serviceTier)
    if (tuned && !data.model)
      throw new HttpError(400, 'Choose a model before selecting an effort level or service tier.')
    const models = tuned ? cachedModels(data.provider, cwd) : undefined
    if (models)
      try {
        checkEffort(models, data)
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid effort level.')
      }
    const now = new Date().toISOString()
    const thread: Thread = {
      id: crypto.randomUUID(),
      title: 'New thread',
      provider: data.provider,
      cwd,
      ...(chat ? { chat: true } : {}),
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
    if (!chat && !this.projectStore.projects.has(cwd)) {
      // Keep the folder in the sidebar even after its threads are deleted. Best effort:
      // the thread already exists, and the folder still appears while it has threads.
      this.projectStore.projects.set(cwd, { path: cwd, addedAt: now })
      await this.projectStore.save().catch(() => this.projectStore.projects.delete(cwd))
    }
    this.notify()
    if (tuned && !models) void this.checkNewThreadSettings(thread)
    return thread
  }
  // The background check for a thread created before its agent's model list was loaded. Saved
  // choices were valid when picked; if one no longer is, fall back to the default effort/tier.
  private async checkNewThreadSettings(thread: Thread) {
    const chosen = { model: thread.model, effort: thread.effort, serviceTier: thread.serviceTier }
    // The CLI not answering says nothing about the setting: keep it.
    const models = await getModels(thread.provider, thread.cwd).catch(() => undefined)
    if (!models) return
    try {
      checkEffort(models, chosen)
    } catch {
      const current = this.store.threads.get(thread.id)
      // Only if the settings are still the ones checked (you may have changed them since).
      if (
        !current ||
        current.effort !== chosen.effort ||
        current.serviceTier !== chosen.serviceTier ||
        current.model !== chosen.model
      )
        return
      current.effort = ''
      delete current.serviceTier
      current.updatedAt = new Date().toISOString()
      await this.store.save().catch(() => {})
      this.notify()
    }
  }
  async updateSettings(id: string, input: unknown) {
    const thread = this.get(id)
    if ((await this.windDown(id)) || this.settingsUpdates.has(id))
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
  // Local or worktree, chosen before the first message (the worktree is made on the first send).
  async setWorktree(id: string, input: unknown) {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(input)
    const thread = this.get(id)
    if (thread.messages.length || thread.sessionId || thread.worktree || this.runs.has(id))
      throw new HttpError(409, 'Start a new thread to change where it works.')
    if (enabled && !(await repoRoot(thread.cwd)))
      throw new HttpError(400, 'Worktrees need a git repository; this project isn’t one.')
    const previous = thread.useWorktree
    if (enabled) thread.useWorktree = true
    else delete thread.useWorktree
    try {
      await this.store.save()
    } catch {
      thread.useWorktree = previous
      throw new HttpError(500, 'Could not save the thread.')
    }
    this.notify()
    return thread
  }
  // Makes the thread's worktree on its first turn (shown as a step), or checks it's still there.
  private async prepareWorktree(thread: Thread, touch: () => void) {
    if (thread.worktree) {
      if (!(await stat(thread.worktree.path).catch(() => null)))
        throw new Error(
          `This thread’s worktree is gone (${thread.worktree.path}). Start a new thread to keep working.`,
        )
      return
    }
    const step: Activity = {
      id: `worktree:${thread.id}`,
      label: 'Worktree',
      title: 'Create a worktree for this thread',
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    thread.activities.push(step)
    touch()
    try {
      thread.worktree = await createWorktree(thread.cwd, thread.id)
    } catch (error) {
      step.status = 'failed'
      step.output = error instanceof Error ? error.message : String(error)
      throw isWorktreeError(error) ? error : new Error('Could not create the worktree.')
    }
    delete thread.useWorktree
    const { branch, path, setupMs, copied } = thread.worktree
    step.status = 'completed'
    step.title = `Create worktree ${branch} (${(setupMs / 1000).toFixed(2)}s)`
    step.detail = path
    step.output = copied
      ? `Copied ${copied} file${copied === 1 ? '' : 's'} from .worktreeinclude.`
      : undefined
    // Saved right away: the worktree exists now, whatever happens to the turn.
    await this.store.save().catch(() => {})
    touch()
  }
  // After deleting threads: remove their worktrees when nothing in them would be lost. One with
  // uncommitted changes is kept (its path is returned). Branches always stay.
  private async cleanUpWorktrees(threads: Thread[]) {
    const kept: string[] = []
    for (const thread of threads) {
      // A chat's folder goes only if it's empty: files the agent made there stay.
      if (thread.chatFolder) await removeChatFolder(thread.chatFolder).catch(() => {})
      const worktree = thread.worktree
      if (!worktree) continue
      const changes = await worktreeChanges(worktree)
      if (changes) {
        kept.push(worktree.path)
        continue
      }
      await removeWorktree(worktree).catch(() => kept.push(worktree.path))
    }
    return kept
  }
  async send(id: string, input: unknown) {
    const { text, attachments: requested } = promptSchema.parse(input)
    const thread = this.get(id)
    // You wrote: a lead may again react to its helpers' reports on its own.
    delete thread.autoTurns
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
    const running = await this.windDown(id)
    // The agent is waiting on its question: a message you send instead of picking an option is
    // your answer ("Something else"), for each question in it.
    const question = running && thread.approvals.find((item) => item.questions?.length)
    if (running && question && text.trim() && running.approvals.has(question.id)) {
      thread.messages.push({ ...message, answered: true })
      thread.updatedAt = message.createdAt
      this.approve(
        id,
        question.id,
        true,
        Object.fromEntries(question.questions!.map((item) => [item.question, text.trim()])),
      )
      // Images can't go into an answer; they follow as a message the agent sees next.
      if (images.length)
        void running.steer?.({ prompt: 'Images for my answer above.', images }).catch(() => false)
      return { accepted: true, answered: true }
    }
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
    // Codex doesn't name threads, so one is written right away; Claude's is read back as soon as
    // it starts replying (see lookForTitle).
    if (firstMessage && thread.provider === 'codex') void this.autoTitle(id)
    return { accepted: true }
  }
  // Replaces the last message of a stopped or failed turn and runs it again. The agent's memory
  // is rewound to before that turn (see TurnCheckpoint); files it changed stay changed.
  async edit(id: string, input: unknown) {
    const { messageId } = z.object({ messageId: z.string().min(1).max(200) }).parse(input)
    const { text, attachments: requested } = promptSchema.parse(input)
    const thread = this.get(id)
    if (await this.windDown(id))
      throw new HttpError(409, 'Stop the agent before editing a message.')
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
      // Never back to working once stopped (the agent may still send a little while it exits).
      if (!thread.approvals.length && !run.controller.signal.aborted) thread.status = 'working'
    }
    // Claude Code writes its session title a moment after the prompt, before its first reply, so
    // look for it as soon as the agent starts answering instead of only when the turn ends.
    // While it's still missing, look again at most every 3 seconds.
    let titleCheckedAt = 0
    const lookForTitle = () => {
      if (thread.provider !== 'claude' || thread.titleSource !== 'message' || !thread.sessionId)
        return
      if (Date.now() - titleCheckedAt < 3_000) return
      titleCheckedAt = Date.now()
      void this.autoTitle(thread.id)
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
      cwd: workdir(thread),
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
        lookForTitle()
      },
      activity: (activity) => {
        const index = thread.activities.findIndex((item) => item.id === activity.id)
        if (index < 0) thread.activities.push({ ...activity, startedAt: new Date().toISOString() })
        else {
          const old = thread.activities[index]
          thread.activities[index] = {
            ...old,
            ...activity,
            label: activity.label === 'Tool' ? old.label : activity.label,
            summary: activity.summary ?? old.summary,
            title: activity.title ?? old.title,
            detail: activity.detail ?? old.detail,
            output: activity.output ?? old.output,
          }
        }
        working()
        touch()
        lookForTitle()
      },
      tools: {
        cwd: workdir(thread),
        processes: projectProcesses(this.processes, thread),
        browser: {
          page: () => this.browsers.page(thread.id),
          openPage: () => this.browsers.openPage(thread.id),
          newTab: () => this.browsers.newTab(thread.id),
          tabs: () => this.browsers.tabs(thread.id),
          switchTab: (id) => this.browsers.switchTab(thread.id, id),
          closeTab: (id) => this.browsers.closeTab(thread.id, id),
          takeLog: () => this.browsers.takeLog(thread.id),
          close: () => this.browsers.close(thread.id),
          recordSnapshot: (snapshot) => this.browsers.recordSnapshot(thread.id, snapshot),
          refName: (ref) => this.browsers.refName(thread.id, ref),
        },
        saveImage: (bytes) => this.uploads.saveImage(bytes),
        saveHtml: (html) => this.uploads.saveHtml(html),
        saveMedia: (file, kind) => this.uploads.saveMedia(file, kind),
        rename: async (title) => (await this.rename(thread.id, { title })).title,
        readThread: async (reference, before) => this.readSharedThread(thread, reference, before),
        threads: this.threadControl(thread),
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
          if (thread.parentId) void this.reportToLead(thread, 'waiting')
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
          if (thread.parentId) void this.reportToLead(thread, 'waiting')
        }),
      todos: (todos) => {
        thread.todos = todos.length ? todos : undefined
        touch()
      },
      background: (tasks) => {
        thread.background = tasks.length ? tasks : undefined
        touch()
      },
      // The agent's latest reply in this turn is an answer: keep it in view when the turn folds.
      replied: () => {
        // From the message that started this turn (a message queued meanwhile comes later).
        const turnStart = started
          ? thread.messages.indexOf(started)
          : thread.messages.map((message) => message.role).lastIndexOf('user')
        const reply = thread.messages
          .slice(turnStart + 1)
          .reverse()
          .find((message) => message.role === 'assistant' && message.text.trim())
        if (!reply || reply.endsReply) return
        reply.endsReply = true
        touch()
      },
    }
    try {
      // A chat gets its own folder on its first turn, named from its first message.
      if (thread.chat && !thread.chatFolder) {
        const first = thread.messages.find((message) => message.role === 'user')
        thread.chatFolder = await createChatFolder(
          thread.cwd,
          thread.id,
          first?.text ?? thread.title,
        )
        await this.store.save().catch(() => {})
        context.cwd = workdir(thread)
        context.tools.cwd = context.cwd
      }
      // A worktree thread gets its worktree on its first turn (and must still have it later).
      if (thread.useWorktree || thread.worktree) {
        await this.prepareWorktree(thread, touch)
        context.cwd = workdir(thread)
        context.tools.cwd = context.cwd
      }
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
      // A stopped turn keeps the time you stopped it (it was shown as stopped then).
      if (!(run.controller.signal.aborted && thread.completedAt))
        thread.completedAt = new Date().toISOString()
      if (thread.status === 'completed')
        this.browserStats.record(thread.provider, thread.activities)
      // Unread unless you're looking at it somewhere (any browser, profile, or phone).
      if (
        (thread.status === 'completed' || thread.status === 'failed') &&
        !this.tabs.isWatching(thread.id)
      )
        thread.unread = true
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
      // A helper's work is done (no follow-up started): its lead hears about it. A stop isn't
      // reported (you or the lead did it).
      if (
        thread.parentId &&
        !this.runs.has(thread.id) &&
        (thread.status === 'completed' || thread.status === 'failed')
      )
        void this.reportToLead(thread, thread.status)
      // Tell every tab first, then save: the save doesn't change what they show.
      this.notify()
      try {
        await this.store.save()
      } catch {
        this.persistenceError =
          'Could not save conversations. Check disk space and permissions, then restart the server.'
        this.notify()
      }
      // A last look in case the title wasn't written yet during the turn (if not, the next turn
      // tries again).
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
            ? await this.titles.claudeSession(thread.sessionId, workdir(thread))
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
  // Orchestration tools (tools/threads.ts): what a lead thread may do with its helper threads.
  // Only its own helpers, and a helper can't start helpers of its own.
  private threadControl(lead: Thread): ThreadControl {
    const helpers = () =>
      [...this.store.threads.values()].filter((item) => item.parentId === lead.id)
    const helper = (reference: string) => {
      const id = threadIdFrom(reference)
      const found = id ? this.store.threads.get(id) : undefined
      if (!found || found.parentId !== lead.id)
        throw new ToolError('That isn’t one of your helper threads (see list_threads for ids).')
      return found
    }
    const refuse = (error: unknown): never => {
      throw new ToolError(error instanceof Error ? error.message : 'That didn’t work.')
    }
    return {
      // Helpers always get a worktree in a git project, so they can't collide.
      start: async ({ task, title, agent }) => {
        if (lead.parentId) throw new ToolError('Helper threads can’t start helpers of their own.')
        const running = helpers().filter((item) => isActive(item.status) || this.runs.has(item.id))
        if (running.length >= maxRunningHelpers)
          throw new ToolError(
            `${maxRunningHelpers} helpers are already running. Wait for one to report back, or stop one.`,
          )
        const provider = agent ?? lead.provider
        const worktree = Boolean(await repoRoot(lead.cwd))
        // The same agent keeps this thread's model and effort; the other agent uses its default.
        const created = await this.create({
          provider,
          cwd: lead.cwd,
          ...(provider === lead.provider
            ? { model: lead.model, effort: lead.effort, serviceTier: lead.serviceTier }
            : {}),
          permissionMode: lead.permissionMode,
        }).catch(refuse)
        created.parentId = lead.id
        created.title = title || task.replace(/\s+/g, ' ').slice(0, 60)
        created.titleSource = title ? 'custom' : 'message'
        try {
          if (worktree) await this.setWorktree(created.id, { enabled: true })
          await this.send(created.id, { text: helperBrief(lead, task) })
        } catch (error) {
          await this.remove(created.id).catch(() => {})
          refuse(error)
        }
        return { id: created.id, title: created.title, agent: agentName(provider), worktree }
      },
      message: async (reference, text) => {
        const target = helper(reference)
        await this.send(target.id, { text }).catch(refuse)
        return `Sent to "${target.title}". It reports back here when it finishes.`
      },
      list: () => {
        const all = helpers()
        if (!all.length) return 'No helper threads yet (start_thread starts one).'
        return all
          .map((item) => {
            const reply = [...item.messages]
              .reverse()
              .find((message) => message.role === 'assistant' && message.text.trim())
            const status =
              item.status === 'waiting'
                ? 'waiting for the user'
                : item.status === 'interrupted'
                  ? 'stopped'
                  : item.status
            return [
              `- "${item.title}" (id ${item.id}) · ${agentName(item.provider)} · ${status}`,
              item.worktree ? ` · branch ${item.worktree.branch}` : '',
              reply ? `\n  Latest reply: ${reply.text.replace(/\s+/g, ' ').slice(0, 300)}` : '',
            ].join('')
          })
          .join('\n')
      },
      stop: async (reference) => {
        const target = helper(reference)
        if (!isActive(target.status) && !this.runs.has(target.id))
          return `"${target.title}" isn’t running.`
        await this.stop(target.id).catch(refuse)
        return `Stopped "${target.title}".`
      },
      remove: async (reference) => {
        const target = helper(reference)
        if (isActive(target.status) || this.runs.has(target.id)) {
          await this.stop(target.id).catch(refuse)
          await this.windDown(target.id)
        }
        const result = await this.remove(target.id).catch(refuse)
        return result.keptWorktrees
          ? `Deleted "${target.title}". Its worktree has uncommitted changes, so it was kept at ${result.keptWorktrees[0]}.`
          : `Deleted "${target.title}"${target.worktree ? ` and its worktree (branch ${target.worktree.branch} stays)` : ''}.`
      },
    }
  }
  // A helper finished (or needs the user): tell its lead with a message, which starts the
  // lead's next turn (or joins its current one). After maxAutoTurns of these in a row, reports
  // still arrive but wait for you.
  private async reportToLead(helper: Thread, status: 'completed' | 'failed' | 'waiting') {
    const lead = helper.parentId ? this.store.threads.get(helper.parentId) : undefined
    if (!lead) return
    const reply = [...helper.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.text.trim())
    const answer =
      status === 'waiting'
        ? `It’s waiting for the user: ${helper.approvals[0]?.title ?? 'an approval'}. They can answer in that thread.`
        : status === 'failed'
          ? `It failed: ${helper.error ?? 'unknown error'}${reply ? `\n\nLast reply:\n${reply.text}` : ''}`
          : (reply?.text ?? '(It finished without a reply.)')
    const clipped = answer.length > 6_000 ? `${answer.slice(0, 6_000)}\n… (cut)` : answer
    const progress = helper.worktree ? await worktreeProgress(helper.worktree) : null
    const branch = helper.worktree
      ? `Branch ${helper.worktree.branch}` +
        (progress
          ? ` (${progress.commits} commit${progress.commits === 1 ? '' : 's'}, ${progress.changes} uncommitted file${progress.changes === 1 ? '' : 's'})`
          : '')
      : 'Works in the project folder'
    const headline = {
      completed: 'finished',
      failed: 'failed',
      waiting: 'is waiting for the user',
    }[status]
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text:
        `[Report from helper thread "${helper.title}" (id ${helper.id}, ${agentName(helper.provider)}): ${headline}. ${branch}.]` +
        `\n\n${clipped}`,
      createdAt: new Date().toISOString(),
      report: {
        threadId: helper.id,
        title: helper.title,
        status,
        ...(helper.worktree ? { branch: helper.worktree.branch } : {}),
        answer: clipped,
      },
    }
    const running = await this.windDown(lead.id)
    if (running) {
      await this.steer(lead, running, message, []).catch(() => {})
      return
    }
    lead.autoTurns = (lead.autoTurns ?? 0) + 1
    if (lead.autoTurns > maxAutoTurns) {
      // Held for you: it shows in the thread, and you decide what happens next.
      message.unsent = true
      lead.messages.push(message)
      lead.updatedAt = message.createdAt
      this.changed()
      return
    }
    lead.messages.push(message)
    await this.startTurn(lead, message.text, [], message.id).catch(() => {
      message.unsent = true
      this.changed()
    })
  }
  // read_thread: another thread, for an agent to pick up from. Only a thread whose link or id
  // appears in the user's own messages in this thread, so an agent can't browse conversations
  // on its own (or be steered into it by a page or file it read). Any project.
  readSharedThread(current: Thread, reference: string, before?: number) {
    const id = threadIdFrom(reference)
    if (!id)
      throw new ToolError('Pass the thread’s link or id (from its right-click menu → Copy link).')
    if (id === current.id) throw new ToolError('That’s this thread.')
    // A lead may read its helpers, and a helper its lead, without the link being shared.
    const family = this.store.threads.get(id)?.parentId === current.id || current.parentId === id
    const shared =
      family ||
      current.messages.some(
        (message) => message.role === 'user' && message.text.toLowerCase().includes(id),
      )
    if (!shared)
      throw new ToolError(
        'Only threads the user shared in this conversation can be read: ask them to paste its link.',
      )
    const thread = this.store.threads.get(id)
    if (!thread) throw new ToolError('That thread doesn’t exist any more.')
    const project = this.projectStore.projects.get(thread.cwd)
    return describeThread(thread, projectLabel(thread.cwd, project?.name), before)
  }
  // Stop shows right away, like Claude Desktop: the thread is marked stopped and every tab is
  // told at once, while the agent finishes exiting in the background (Claude ends the turn
  // cleanly, see providers/claude.ts). Anything that needs the run gone waits for that first
  // (windDown).
  async stop(id: string) {
    const thread = this.get(id)
    const run = this.runs.get(id)
    if (run && !run.controller.signal.aborted) {
      run.controller.abort()
      // The run's end, saving included (it leaves `runs` before it saves).
      const ending: Promise<void> = run.done
        .catch(() => {})
        .then(() => {
          if (this.winding.get(id) === ending) this.winding.delete(id)
        })
      this.winding.set(id, ending)
      for (const resolve of run.approvals.values()) resolve(false)
      run.approvals.clear()
      thread.status = 'interrupted'
      thread.approvals = []
      thread.background = undefined
      thread.activities = thread.activities.map((activity) =>
        activity.status === 'running' ? { ...activity, status: 'failed' } : activity,
      )
      thread.completedAt = new Date().toISOString()
      thread.updatedAt = thread.completedAt
      // Messages queued during the turn stay, but never go out: stop means stop.
      for (const item of run.queued) {
        const message = thread.messages.find((entry) => entry.id === item.messageId)
        if (!message) continue
        delete message.queued
        message.unsent = true
      }
      run.queued = []
      this.notify()
    }
    return { ok: true }
  }
  // A stopped run that's still exiting: wait for it to finish, so what comes next (a new turn,
  // an edit, a delete) never overlaps it. Returns the run still going, if any.
  async windDown(id: string) {
    for (let ending = this.winding.get(id); ending; ending = this.winding.get(id)) await ending
    let run = this.runs.get(id)
    while (run?.controller.signal.aborted) {
      await run.done.catch(() => {})
      run = this.runs.get(id)
    }
    return run
  }
  async close() {
    await Promise.all(
      [...this.runs.entries()].map(async ([id, run]) => {
        await this.stop(id)
        await run.done.catch(() => {})
      }),
    )
    await this.processes.stopAll()
    await this.browsers.closeAll()
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
    const cwd = workdir(this.get(id))
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
  // The open pull request for the thread's branch, if it has one on GitHub: found by matching the
  // branch's pushed commit against GitHub's refs/pull/<n>/head refs, keeping only PRs that still
  // have a refs/pull/<n>/merge ref (open ones; see pullRequestFor), through `git ls-remote` with
  // your normal git login (no gh CLI, no token). Kept separate from gitInfo because it's a network
  // call; the ref list is fetched at most once a minute per repository.
  private pullRefs = new Map<string, { at: number; refs: Promise<string> }>()
  async pullRequest(id: string): Promise<PullRequest | null> {
    const cwd = workdir(this.get(id))
    const git = async (args: string[], timeout = 3_000) =>
      (
        await exec('git', ['-C', cwd, ...args], {
          timeout,
          maxBuffer: 16 * 1024 * 1024,
          // Never wait on a password or passphrase prompt.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        })
      ).stdout.trim()
    try {
      const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
      const remote = await git(['config', '--get', `branch.${branch}.remote`])
      if (!remote || remote === '.' || remote.startsWith('-')) return null
      // The URL as configured (get-url would apply insteadOf rewrites).
      const repo = githubRepoUrl(await git(['config', '--get', `remote.${remote}.url`]))
      if (!repo) return null
      // Not the default branch: after a fast-forward or rebase merge, main's tip can be an old
      // pull request's head, which isn't main's pull request.
      const upstream = await git(['rev-parse', '--abbrev-ref', '@{upstream}'])
      const defaultBranch = await git([
        'symbolic-ref',
        '--quiet',
        '--short',
        `refs/remotes/${remote}/HEAD`,
      ]).catch(() => '')
      if (upstream === defaultBranch) return null
      // The branch's commit as last pushed (its remote-tracking ref).
      const sha = await git(['rev-parse', '--verify', '--quiet', '@{upstream}'])
      const key = `${cwd}\n${remote}`
      let cached = this.pullRefs.get(key)
      if (!cached || Date.now() - cached.at > 60_000) {
        const refs = git(['ls-remote', remote, 'refs/pull/*'], 10_000)
        cached = { at: Date.now(), refs }
        this.pullRefs.set(key, cached)
        refs.catch(() => this.pullRefs.delete(key))
      }
      const number = pullRequestFor(await cached.refs, sha)
      return number ? { number, url: githubPullUrl(repo, number) } : null
    } catch {
      return null
    }
  }
  // Uncommitted changes in a thread's project: tracked files against HEAD plus new untracked
  // files. git runs without a shell, in the thread's own folder, with output caps.
  async diff(id: string): Promise<DiffResult> {
    const cwd = workdir(this.get(id))
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
    const cwd = workdir(this.get(id))
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
    const cwd = workdir(this.get(id))
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
    if (isActive(thread.status) || (await this.windDown(id)) || this.settingsUpdates.has(id))
      throw new HttpError(409, 'Stop the agent before deleting this thread.')
    this.store.threads.delete(id)
    try {
      await this.store.save()
    } catch {
      this.store.threads.set(id, thread)
      throw new HttpError(500, 'Could not delete the thread.')
    }
    await this.keepProjectPlace(thread)
    void this.browsers.close(id)
    this.notify()
    const kept = await this.cleanUpWorktrees([thread])
    return { ok: true, ...(kept.length ? { keptWorktrees: kept } : {}) }
  }
}
const globals = globalThis as typeof globalThis & { t3MiniService?: Promise<AgentService> }
export function getService() {
  return (globals.t3MiniService ??= (async () => {
    const store = new ThreadStore(defaultStorePath())
    await store.load()
    const service = new AgentService(store, undefined, undefined, undefined, undefined, titleWriter)
    await service.projectStore.load()
    await service.ui.load()
    await service.browserStats.load()
    // Load the agents' model lists now, so creating the first thread doesn't wait for them.
    warmModels()
    return service
  })())
}
