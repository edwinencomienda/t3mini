import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  createApnsSender,
  readApnsConfig,
  type ApnsConfig,
  type ApnsEnvironment,
  type ApnsSender,
} from './apns'
import { getRemoteAccess } from './remote'
import type { Status, Thread } from '../types'

// Live Activities for the native iOS app (ios/): a thread you sent from the phone stays on its
// lock screen and Dynamic Island while the agent works (Working, Waiting for you, Done…), kept
// current by this server through Apple's push service even when the app is closed.
//
// - The app starts the activity and registers the push token iOS gives it for that one activity
//   (POST /api/push/activity, paired devices through the gateway only). Tokens are kept in
//   live-activities.json (mode 0600), bounded, and dropped once the activity ends, after 8 hours
//   (Apple's limit), when Apple says they're gone, or when the device is revoked.
// - Apple can read Live Activity updates (iOS can't decrypt them on the phone the way the
//   notification extension does), so they carry no text at all: only the status, the step
//   count, and times. The title and project are set on the phone when it starts the activity and
//   never go through Apple.
// - Status changes go out at once (priority 10); a growing step count at most every 15 s, at
//   priority 5, so the phone isn't woken for every step. The turn ending ends the activity, which
//   shows the result for 15 minutes.

export type ActivityStatus = 'working' | 'waiting' | 'done' | 'failed' | 'stopped'
// The activity's content state, exactly as the app decodes it (ThreadActivityAttributes in
// ios/LiveActivity). Times are Unix seconds.
export type ActivityState = {
  status: ActivityStatus
  steps: number
  startedAt: number
  endedAt?: number
}

type Entry = {
  token: string
  thread: string
  environment: ApnsEnvironment
  // The app's bundle id; the push topic adds '.push-type.liveactivity'.
  topic: string
  deviceId?: string
  createdAt: string
  // What the phone shows now (what was last sent), and when.
  sent?: ActivityState
  sentAt?: number
  // Seen working since it was registered (a just-registered activity isn't ended by a thread
  // that hasn't picked up the new message yet).
  active?: boolean
}

export const activitySchema = z.object({
  // Live Activity push tokens are longer than device tokens.
  token: z.string().regex(/^[0-9a-fA-F]{64,400}$/),
  thread: z.string().min(1).max(100),
  environment: z.enum(['sandbox', 'production']),
  topic: z
    .string()
    .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/)
    .max(155),
})

const maxEntries = 20
const maxAge = 8 * 60 * 60_000
const stepInterval = 15_000
const showEndedFor = 15 * 60
// A new activity whose thread hasn't started working yet isn't ended for this long.
const startGrace = 30_000

const seconds = (iso?: string) => {
  const time = iso ? Date.parse(iso) : NaN
  return Number.isFinite(time) ? Math.floor(time / 1000) : undefined
}

// What the activity should show for a thread: when its latest turn started (your latest
// message), its steps so far, and how it ended.
export function activityState(thread: Thread): ActivityState {
  const status: ActivityStatus =
    thread.status === 'starting' || thread.status === 'working'
      ? 'working'
      : thread.status === 'waiting'
        ? 'waiting'
        : thread.status === 'failed'
          ? 'failed'
          : thread.status === 'interrupted'
            ? 'stopped'
            : 'done'
  const lastMessage = [...thread.messages].reverse().find((message) => message.role === 'user')
  const startedAt = seconds(lastMessage?.createdAt) ?? seconds(thread.updatedAt) ?? 0
  const steps = thread.activities.filter((activity) => !activity.todo).length
  const ended = status === 'done' || status === 'failed' || status === 'stopped'
  const endedAt = ended ? (seconds(thread.completedAt) ?? Math.floor(Date.now() / 1000)) : undefined
  return { status, steps, startedAt, ...(endedAt !== undefined ? { endedAt } : {}) }
}

const ended = (state: ActivityState) => state.status !== 'working' && state.status !== 'waiting'
const isRunning = (status: Status) =>
  status === 'starting' || status === 'working' || status === 'waiting'

export class LiveActivities {
  private entries?: Entry[]
  private sending = new Set<Promise<unknown>>()
  constructor(
    readonly path: string,
    private options: {
      thread: (id: string) => Thread | undefined
      apns: { config: () => Promise<ApnsConfig | null>; send: ApnsSender }
      deviceExists?: (id: string) => boolean | Promise<boolean>
      now?: () => number
    },
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private async load() {
    if (this.entries) return this.entries
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      this.entries = Array.isArray(data)
        ? (data as Entry[]).filter(
            (item) =>
              activitySchema.safeParse(item).success &&
              this.now() - Date.parse(item.createdAt) < maxAge,
          )
        : []
    } catch {
      this.entries = []
    }
    return this.entries
  }
  private async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(this.path + '.tmp', JSON.stringify(this.entries ?? []), { mode: 0o600 })
    await rename(this.path + '.tmp', this.path)
  }

  // The app registers an activity's push token for a thread.
  async register(input: unknown, deviceId?: string) {
    const data = activitySchema.parse(input)
    if (!this.options.thread(data.thread)) throw new Error('Thread not found.')
    const token = data.token.toLowerCase()
    const entries = await this.load()
    const next = entries.filter((item) => item.token !== token)
    next.push({
      ...data,
      token,
      ...(deviceId ? { deviceId } : {}),
      createdAt: new Date(this.now()).toISOString(),
    })
    this.entries = next.slice(-maxEntries)
    await this.save()
  }
  async unregister(token: string) {
    const entries = await this.load()
    this.entries = entries.filter((item) => item.token !== token.toLowerCase())
    if (this.entries.length !== entries.length) await this.save()
  }
  async registered(token: string) {
    return (await this.load()).some((item) => item.token === token.toLowerCase())
  }
  async removeDevice(id?: string) {
    const entries = await this.load()
    this.entries = entries.filter((item) => (id ? item.deviceId !== id : !item.deviceId))
    if (this.entries.length !== entries.length) await this.save()
  }

  // Brings every activity up to date with its thread: called when threads change (throttled by
  // the caller). Returns once the messages have gone.
  async update() {
    const apns = this.options.apns
    const config = await apns.config()
    const entries = await this.load()
    if (!entries.length) return
    const now = this.now()
    const drop = new Set<string>()
    let changed = false
    await Promise.all(
      entries.map(async (entry) => {
        const thread = this.options.thread(entry.thread)
        if (!thread || now - Date.parse(entry.createdAt) > maxAge) return void drop.add(entry.token)
        if (entry.deviceId && !(await this.options.deviceExists?.(entry.deviceId)))
          return void drop.add(entry.token)
        if (isRunning(thread.status) && !entry.active) {
          entry.active = true
          changed = true
        }
        const state = activityState(thread)
        // Not started yet (the message is still on its way): leave it alone for a moment.
        if (ended(state) && !entry.active && now - Date.parse(entry.createdAt) < startGrace) return
        const previous = entry.sent
        const statusChanged =
          previous?.status !== state.status || previous?.startedAt !== state.startedAt
        const stepsChanged = previous?.steps !== state.steps
        if (!statusChanged && !stepsChanged) return
        if (!statusChanged && now - (entry.sentAt ?? 0) < stepInterval) return
        if (!config) return
        const end = ended(state)
        const result = await apns.send(config, {
          token: entry.token,
          environment: entry.environment,
          topic: `${entry.topic}.push-type.liveactivity`,
          pushType: 'liveactivity',
          priority: statusChanged ? 10 : 5,
          payload: {
            aps: {
              timestamp: Math.floor(now / 1000),
              event: end ? 'end' : 'update',
              'content-state': state,
              ...(end ? { 'dismissal-date': Math.floor(now / 1000) + showEndedFor } : {}),
            },
          },
        })
        if (result === 'gone' || (result === 'sent' && end)) return void drop.add(entry.token)
        if (result === 'sent') {
          entry.sent = state
          entry.sentAt = now
          changed = true
        }
      }),
    )
    if (drop.size) this.entries = (this.entries ?? []).filter((item) => !drop.has(item.token))
    if (drop.size || changed) await this.save()
  }
  queue() {
    const task = this.update().catch(() => {})
    this.sending.add(task)
    void task.finally(() => this.sending.delete(task))
  }
  async idle() {
    await Promise.all(this.sending)
  }
}

// Keeps activities current as threads change: at most once a second while a reply streams.
export function watchActivities(
  service: { subscribe: (listener: () => void) => () => void },
  activities: Pick<LiveActivities, 'queue'>,
  delay = 1000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = service.subscribe(() => {
    timer ??= setTimeout(() => {
      timer = undefined
      activities.queue()
    }, delay)
  })
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}

// One per server process (kept across dev reloads, like push notifications).
const globals = globalThis as typeof globalThis & { t3MiniActivities?: LiveActivities }
export function activitiesIn(data: string, thread: (id: string) => Thread | undefined) {
  return (globals.t3MiniActivities ??= new LiveActivities(join(data, 'live-activities.json'), {
    thread,
    apns: { config: () => readApnsConfig(join(data, 'apns.json')), send: createApnsSender() },
    deviceExists: async (id) => (await getRemoteAccess(join(data, 'devices.json'))).devices.has(id),
  }))
}
