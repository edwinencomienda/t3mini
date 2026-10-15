import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { isActive, type Bootstrap, type Provider, type Thread, type ThreadSummary } from '../types'
import { ThreadStore, defaultStorePath } from './store'
import { runCodex } from './providers/codex'
import { runClaude } from './providers/claude'
import type { Runner } from './providers/types'
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
const promptSchema = z.object({ text: z.string().trim().min(1).max(100_000) })
const exec = promisify(execFile)
const summary = ({ id, title, provider, cwd, status, updatedAt }: Thread): ThreadSummary => ({
  id,
  title,
  provider,
  cwd,
  status,
  updatedAt,
})
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
  ) {}
  list() {
    return [...this.store.threads.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summary)
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
    return { threads: this.list(), providers: { codex, claude }, defaultCwd: homedir() }
  }
  async create(input: unknown) {
    const data = createSchema.parse(input)
    const expanded =
      data.cwd === '~'
        ? homedir()
        : data.cwd.startsWith('~/')
          ? join(homedir(), data.cwd.slice(2))
          : data.cwd
    if (!isAbsolute(expanded))
      throw new HttpError(400, 'Use an absolute project folder path, or start with ~/ .')
    let cwd: string
    try {
      cwd = await realpath(expanded)
      if (!(await stat(cwd)).isDirectory()) throw new Error()
    } catch {
      throw new HttpError(400, 'That project folder does not exist on this machine.')
    }
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
    const data = settingsSchema.parse(input)
    this.settingsUpdates.add(id)
    try {
      try {
        await validateEffort(thread.provider, thread.cwd, data)
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid effort level.')
      }
      const previous = {
        model: thread.model,
        effort: thread.effort,
        permissionMode: thread.permissionMode,
      }
      Object.assign(thread, data)
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
    const { text } = promptSchema.parse(input)
    const thread = this.get(id)
    if (this.persistenceError) throw new HttpError(500, this.persistenceError)
    if (this.settingsUpdates.has(id))
      throw new HttpError(409, 'Agent settings are still saving. Try sending again.')
    if (this.runs.has(id)) throw new HttpError(409, 'This thread is already working.')
    const previous = structuredClone(thread)
    const now = new Date().toISOString()
    thread.messages.push({ id: crypto.randomUUID(), role: 'user', text, createdAt: now })
    if (thread.title === 'New thread') thread.title = text.slice(0, 60)
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
    run.done = this.execute(thread, text, run)
    return { accepted: true }
  }
  private async execute(thread: Thread, prompt: string, run: Run) {
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
    return new AgentService(store)
  })())
}
