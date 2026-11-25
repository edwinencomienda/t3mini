import type { Thread, ThreadSummary } from '../types'
import type { AppUpdate } from './app-update'
import type { ProviderUpdate } from './cli-updates'
import type { Machines } from './machines'

// The hub, watched by this server (docs/machines.md → Push notifications and Live Activities):
// the machines added under Settings → Machines each get one live connection from here (their
// /api/events, through machines.ts forward() with the session this server holds), so a machine's
// threads get the same push notifications, Live Activities, dictation words, and read marks as
// this computer's own, even when no browser or app is open. Nothing new runs on the machine.
//
// Ids are the hub's ("m~<machine>~<thread id>", like src/hub.ts and the iPhone app), so pushes
// open the right thread and never mix with this computer's.

const mark = 'm~'
export const hubId = (machine: string, value: string) => `${mark}${machine}~${value}`
export function parseHubId(value: string | null | undefined) {
  if (!value?.startsWith(mark)) return null
  const rest = value.slice(mark.length)
  const split = rest.indexOf('~')
  if (split <= 0) return null
  return { machine: rest.slice(0, split), id: rest.slice(split + 1) }
}

type Feed = {
  name: string
  stop: () => void
  threads: ThreadSummary[]
  projects: Map<string, string>
  // The machine's own agent CLI updates and t3mini install (from its live updates; a machine on
  // an older t3mini sends neither).
  providerUpdates?: ProviderUpdate[]
  appUpdate?: AppUpdate
  // How many of its agents are working (restarting it would stop them).
  running: number
}
// One machine's updates, as this computer's clients get them (machineUpdates in /api/events).
export type MachineUpdates = {
  machine: string
  name: string
  providerUpdates: ProviderUpdate[]
  appUpdate?: AppUpdate
  running: number
}
const activeStatuses = new Set(['starting', 'working', 'waiting'])
type MachineSource = Pick<Machines, 'list' | 'forward'>

// Whole threads kept current for Live Activities and dictation: the most recent ones asked for.
const maxFollowed = 50

export class HubWatch {
  private feeds = new Map<string, Feed>()
  private listeners = new Set<() => void>()
  // Told only when a machine's updates change (not on every thread change).
  private updateListeners = new Set<() => void>()
  private full = new Map<string, Thread>()
  private followed: string[] = []
  private loading = new Map<string, Promise<Thread | undefined>>()
  private again = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(
    private machines: MachineSource,
    private options: { refreshMs?: number; retryMs?: (attempt: number) => number } = {},
  ) {}

  // Checks which machines are online now and every minute, and keeps one feed open per machine.
  start() {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.options.refreshMs ?? 60_000)
    this.timer.unref?.()
  }
  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const feed of this.feeds.values()) feed.stop()
    this.feeds.clear()
  }

  async refresh() {
    const online = (await this.machines.list().catch(() => [])).filter(
      (machine) => machine.status === 'online',
    )
    if (this.stopped) return
    const ids = new Set(online.map((machine) => machine.id))
    let changed = false
    for (const [id, feed] of this.feeds)
      if (!ids.has(id)) {
        feed.stop()
        this.feeds.delete(id)
        changed = true
      }
    for (const machine of online) {
      const feed = this.feeds.get(machine.id)
      if (feed) feed.name = machine.name
      else this.feeds.set(machine.id, this.open(machine.id, machine.name))
    }
    if (changed) {
      this.notify()
      this.notifyUpdates()
    }
  }

  // One machine's live updates: its thread list and projects. Reconnects with a growing wait
  // while the machine stays in the online list.
  private open(machine: string, name: string): Feed {
    const controller = new AbortController()
    const feed: Feed = {
      name,
      stop: () => controller.abort(),
      threads: [],
      projects: new Map(),
      running: 0,
    }
    const run = async () => {
      let attempt = 0
      while (!controller.signal.aborted) {
        try {
          const reply = await this.machines.forward(
            machine,
            'events',
            new Request(`http://127.0.0.1/api/m/${encodeURIComponent(machine)}/events`, {
              signal: controller.signal,
            }),
          )
          if (reply.status !== 200 || !reply.body) throw new Error(`events ${reply.status}`)
          attempt = 0
          for await (const data of events(reply.body)) this.receive(machine, feed, data)
        } catch {
          // Unreachable or ended: try again shortly (the minute check drops offline machines).
        }
        if (controller.signal.aborted) return
        const wait = this.options.retryMs?.(attempt) ?? Math.min(1000 * 2 ** attempt, 30_000)
        attempt++
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    void run()
    return feed
  }

  private receive(machine: string, feed: Feed, data: string) {
    let update: {
      threads?: ThreadSummary[]
      projects?: { path: string; name?: string }[]
      providerUpdates?: ProviderUpdate[]
      appUpdate?: AppUpdate
    }
    try {
      update = JSON.parse(data) as typeof update
    } catch {
      return
    }
    if (update.providerUpdates || update.appUpdate) {
      if (Array.isArray(update.providerUpdates)) feed.providerUpdates = update.providerUpdates
      if (update.appUpdate && typeof update.appUpdate === 'object')
        feed.appUpdate = update.appUpdate
      this.notifyUpdates()
    }
    if (update.projects)
      feed.projects = new Map(
        update.projects.map((project) => [hubId(machine, project.path), project.name ?? '']),
      )
    if (!update.threads) return
    const before = new Map(feed.threads.map((item) => [item.id, item]))
    feed.threads = update.threads.map((item) => ({
      ...item,
      id: hubId(machine, item.id),
      cwd: hubId(machine, item.cwd),
      ...(item.parentId ? { parentId: hubId(machine, item.parentId) } : {}),
      machine: feed.name,
    }))
    const running = feed.threads.filter((item) => activeStatuses.has(item.status)).length
    if (running !== feed.running) {
      feed.running = running
      if (feed.appUpdate?.ready) this.notifyUpdates()
    }
    // Whole threads that are followed (a Live Activity) are fetched again when they changed.
    for (const item of feed.threads) {
      const old = before.get(item.id)
      if (
        this.full.has(item.id) &&
        (!old || old.status !== item.status || old.updatedAt !== item.updatedAt)
      )
        void this.load(item.id)
    }
    this.notify()
  }

  // Every online machine's agent updates and t3mini install, by machine.
  updates(): MachineUpdates[] {
    return [...this.feeds.entries()]
      .filter(([, feed]) => feed.providerUpdates || feed.appUpdate)
      .map(([machine, feed]) => ({
        machine,
        name: feed.name,
        providerUpdates: feed.providerUpdates ?? [],
        ...(feed.appUpdate ? { appUpdate: feed.appUpdate } : {}),
        running: feed.running,
      }))
  }
  onUpdates(listener: () => void) {
    this.updateListeners.add(listener)
    return () => void this.updateListeners.delete(listener)
  }
  private notifyUpdates() {
    for (const listener of this.updateListeners) listener()
  }

  // Every online machine's threads, with hub ids.
  list(): ThreadSummary[] {
    return [...this.feeds.values()].flatMap((feed) => feed.threads)
  }
  summary(id: string) {
    const machine = parseHubId(id)?.machine
    return machine ? this.feeds.get(machine)?.threads.find((item) => item.id === id) : undefined
  }
  // A machine project's name for notifications ("app · vps"), else its folder's.
  projectName(cwd: string) {
    const parsed = parseHubId(cwd)
    const feed = parsed ? this.feeds.get(parsed.machine) : undefined
    const name = feed?.projects.get(cwd) || parsed?.id.split('/').filter(Boolean).pop() || cwd
    return feed ? `${name} · ${feed.name}` : name
  }

  // A machine's whole thread as last fetched (Live Activities read it on every update).
  thread(id: string) {
    return this.full.get(id)
  }
  // Fetches a machine's whole thread now and keeps it current from then on. One fetch at a
  // time per thread; a change during it fetches once more after.
  load(id: string): Promise<Thread | undefined> {
    const parsed = parseHubId(id)
    if (!parsed) return Promise.resolve(undefined)
    const running = this.loading.get(id)
    if (running) {
      this.again.add(id)
      return running
    }
    const task = (async () => {
      try {
        const reply = await this.machines.forward(
          parsed.machine,
          `threads/${encodeURIComponent(parsed.id)}`,
          new Request(
            `http://127.0.0.1/api/m/${encodeURIComponent(parsed.machine)}/threads/${encodeURIComponent(parsed.id)}`,
          ),
        )
        if (reply.status !== 200) {
          await reply.body?.cancel()
          return this.full.get(id)
        }
        const thread = (await reply.json()) as Thread
        const mapped: Thread = {
          ...thread,
          id,
          cwd: hubId(parsed.machine, thread.cwd),
        }
        this.full.set(id, mapped)
        this.followed = [...this.followed.filter((item) => item !== id), id]
        while (this.followed.length > maxFollowed) this.full.delete(this.followed.shift()!)
        this.notify()
        return mapped
      } catch {
        return this.full.get(id)
      } finally {
        this.loading.delete(id)
        if (this.again.delete(id)) void this.load(id)
      }
    })()
    this.loading.set(id, task)
    return task
  }

  // Whether you're at that machine right now and its t3 mini will show the desktop
  // notification there (its GET /api/presence; an older machine, or one that doesn't answer
  // within 3 seconds, counts as no). Asked when a push is decided, so it's always current.
  async machineAtDesk(machine: string) {
    try {
      const reply = await this.machines.forward(
        machine,
        'presence',
        new Request(`http://127.0.0.1/api/m/${encodeURIComponent(machine)}/presence`, {
          signal: AbortSignal.timeout(3000),
        }),
      )
      if (reply.status !== 200) {
        await reply.body?.cancel()
        return false
      }
      const data = (await reply.json()) as { atDesk?: unknown }
      return data.atDesk === true
    } catch {
      return false
    }
  }
  // Marks a machine's thread read there (you watched it finish here).
  async markRead(id: string) {
    const parsed = parseHubId(id)
    if (!parsed) return
    const reply = await this.machines
      .forward(
        parsed.machine,
        `threads/${encodeURIComponent(parsed.id)}/read`,
        new Request(
          `http://127.0.0.1/api/m/${encodeURIComponent(parsed.machine)}/threads/${encodeURIComponent(parsed.id)}/read`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        ),
      )
      .catch(() => null)
    await reply?.body?.cancel()
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  private notify() {
    for (const listener of this.listeners) listener()
  }
}

// The `data:` payloads of a Server-Sent Events body.
export async function* events(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') {
        if (data.length) yield data.join('\n')
        data = []
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
  }
}

// One per server process (kept across dev reloads, like the machines and push stores).
const globals = globalThis as typeof globalThis & { t3MiniHub?: HubWatch }
export function getHubWatch(machines: MachineSource) {
  return (globals.t3MiniHub ??= new HubWatch(machines))
}
