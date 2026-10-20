import { spawn, type ChildProcess } from 'node:child_process'

// Long-running processes (dev servers, watchers…) that agents start through t3 mini's tools
// and the user manages from the UI. Each runs in its own process group so Stop takes its
// children with it. Kept in memory only: they're stopped when t3 mini shuts down.

export type ProcessStatus = 'running' | 'stopping' | 'exited' | 'failed' | 'stopped'
export type ProcessInfo = {
  id: string
  name: string
  command: string
  cwd: string
  // The project the process belongs to (a thread's folder).
  project: string
  threadId?: string
  status: ProcessStatus
  pid?: number
  exitCode?: number | null
  startedAt: string
  endedAt?: string
  // First local URL the process printed, e.g. http://localhost:5173.
  url?: string
  // Every local address it printed (origins, in order, up to 5): a monorepo's `dev` often starts
  // a website and an API side by side (http://localhost:3000, http://localhost:3001).
  urls?: string[]
}

export const maxProcessesPerProject = 10
const maxLogBytes = 256 * 1024
const stopGraceMs = 5_000
// Never hand t3 mini's own secrets to processes agents start.
const privateEnv = ['DEEPGRAM_API_KEY', 'DEEPGRAM_MODEL', 'T3_MINI_PHONE_PORT', 'T3_MINI_DATA_DIR']

// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const localUrl =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s'"`)]*)?/i
const localUrls = new RegExp(localUrl.source, 'gi')

// When t3 mini stops (Ctrl+C, a restart, an exit), take running process groups with it so dev
// servers aren't left orphaned holding their ports. Signals matter too: by default Node exits
// on SIGINT/SIGTERM without running 'exit' handlers. Hooked once for all managers.
const managers = new Set<ProcessManager>()
let hooked = false
function hookShutdown() {
  if (hooked) return
  hooked = true
  const killAll = () => managers.forEach((manager) => manager.killAllNow())
  process.once('exit', killAll)
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)
    process.once(signal, () => {
      killAll()
      // If something else (like Vite) handles this signal, let it finish shutting down;
      // otherwise exit the way Node would have.
      if (process.listenerCount(signal) === 0) process.exit(code)
    })
}

type Entry = { info: ProcessInfo; child?: ChildProcess; log: string; killTimer?: NodeJS.Timeout }

export class ProcessManager {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  constructor() {
    managers.add(this)
    hookShutdown()
  }
  // Signals every running process group to stop (synchronous, for shutdown hooks).
  killAllNow() {
    for (const entry of this.entries.values())
      if (entry.child?.pid)
        try {
          process.kill(-entry.child.pid, 'SIGTERM')
        } catch {
          // Already gone.
        }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  private changed() {
    for (const listener of this.listeners) listener()
  }

  list(project?: string): ProcessInfo[] {
    return [...this.entries.values()]
      .map((entry) => entry.info)
      .filter((info) => !project || info.project === project)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }
  get(id: string) {
    return this.entries.get(id)?.info
  }
  // The last `lines` lines of output (ANSI colors removed).
  logs(id: string, lines = 200) {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    const all = entry.log.split('\n')
    if (all.at(-1) === '') all.pop()
    return all.slice(-Math.max(1, Math.min(lines, 2000))).join('\n')
  }

  start(input: { name: string; command: string; cwd: string; project: string; threadId?: string }) {
    const active = this.list(input.project).filter((info) => info.status === 'running')
    if (active.length >= maxProcessesPerProject)
      throw new Error(`This project already has ${maxProcessesPerProject} running processes.`)
    // Finished entries for the project are pruned as new ones start, keeping the list short.
    for (const info of this.list(input.project).slice(maxProcessesPerProject * 2))
      if (info.status !== 'running' && info.status !== 'stopping') this.entries.delete(info.id)
    const info: ProcessInfo = {
      id: crypto.randomUUID().slice(0, 8),
      name: input.name,
      command: input.command,
      cwd: input.cwd,
      project: input.project,
      threadId: input.threadId,
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    const entry: Entry = { info, log: '' }
    this.entries.set(info.id, entry)
    this.launch(entry)
    return info
  }

  private launch(entry: Entry) {
    const env = { ...process.env }
    for (const key of privateEnv) delete env[key]
    // A login shell so PATH (nvm, Homebrew…) matches the user's terminal. The command is the
    // agent's own shell command, like its Bash tool; it's never built from other input.
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', entry.info.command], {
      cwd: entry.info.cwd,
      env: { ...env, FORCE_COLOR: '0' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    entry.child = child
    entry.info.pid = child.pid
    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8').replace(ansi, '')
      entry.log += text
      if (entry.log.length > maxLogBytes) entry.log = entry.log.slice(-maxLogBytes)
      let found = false
      for (const match of text.matchAll(localUrls)) {
        const url = match[0].replace('0.0.0.0', 'localhost')
        const origin = new URL(url).origin
        const urls = entry.info.urls ?? []
        if (!entry.info.url) entry.info.url = url
        if (urls.length < 5 && !urls.includes(origin)) {
          entry.info.urls = [...urls, origin]
          found = true
        }
      }
      if (found) this.changed()
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => {
      entry.log += `\n[t3 mini] Could not start: ${error.message}\n`
      this.finish(entry, null)
    })
    child.on('exit', (code) => this.finish(entry, code))
    this.changed()
  }

  private finish(entry: Entry, code: number | null) {
    if (entry.killTimer) clearTimeout(entry.killTimer)
    entry.killTimer = undefined
    const wasStopping = entry.info.status === 'stopping'
    entry.info.status = wasStopping ? 'stopped' : code === 0 ? 'exited' : 'failed'
    entry.info.exitCode = code
    entry.info.endedAt = new Date().toISOString()
    entry.child = undefined
    this.changed()
  }

  // Stops the whole process group: SIGTERM first, SIGKILL if it hasn't exited in 5 seconds.
  async stop(id: string) {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('Process not found.')
    const child = entry.child
    if (!child || entry.info.status !== 'running') return entry.info
    entry.info.status = 'stopping'
    this.changed()
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, name)
      } catch {
        child.kill(name)
      }
    }
    signal('SIGTERM')
    entry.killTimer = setTimeout(() => signal('SIGKILL'), stopGraceMs)
    await exited
    return entry.info
  }

  async restart(id: string) {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('Process not found.')
    if (entry.info.status === 'running' || entry.info.status === 'stopping') await this.stop(id)
    entry.log += `\n[t3 mini] Restarted at ${new Date().toLocaleTimeString()}\n`
    Object.assign(entry.info, {
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: undefined,
      exitCode: undefined,
      url: undefined,
      urls: undefined,
    })
    this.launch(entry)
    return entry.info
  }

  // Removes a finished process from the list.
  remove(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.info.status === 'running' || entry.info.status === 'stopping')
      throw new Error('Stop the process before removing it.')
    this.entries.delete(id)
    this.changed()
  }

  async stopAll() {
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.info.status === 'running')
        .map((entry) => this.stop(entry.info.id)),
    )
  }
}
