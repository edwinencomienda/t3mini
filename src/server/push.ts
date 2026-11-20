import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { generateVAPIDKeys, sendNotification } from 'web-push'
import { z } from 'zod'
import { threadEvents, eventLabel, type ThreadEvent } from '../notifications'
import {
  createApnsSender,
  readApnsConfig,
  type ApnsConfig,
  type ApnsEnvironment,
  type ApnsSender,
} from './apns'
import { getRemoteAccess } from './remote'
import type { Status, ThreadSummary } from '../types'

// Push notifications (Web Push) for t3 mini added to a phone's home screen, or any browser that
// supports it: a thread finished, failed, or needs you, even with the app closed.
//
// - This server signs pushes with its own key pair (VAPID), made once and kept in push.json
//   (mode 0600) next to the other data. The private key never leaves this file.
// - A browser subscribes (POST /api/push), which gives us an address at its push service (Apple,
//   Google, Mozilla, Microsoft) and keys to encrypt for it. Messages are end-to-end encrypted to
//   the browser: the push service delivers them but can't read them.
// - We only ever send to those push services (allowedPushHost), never to an address of the
//   subscriber's choosing, so a subscription can't make this server call anything else.
// - A subscription from a paired device belongs to that device: revoking the device (Settings →
//   Devices) stops its pushes, and so does the session expiring.

type Subscription = {
  endpoint: string
  keys: { p256dh: string; auth: string }
  // The paired device it came from (the gateway's x-t3-device); absent for this Mac's browsers.
  deviceId?: string
  createdAt: string
}
// The native iOS app (ios/) on a device: its APNs token, which of Apple's two services it uses
// (development builds: sandbox), and its bundle id (the APNs topic). See apns.ts.
type AppDevice = {
  token: string
  environment: ApnsEnvironment
  topic: string
  // A key the app made and keeps on the phone (base64, 32 bytes): the title and project are
  // encrypted with it (AES-256-GCM), so Apple can't read them; the app's notification extension
  // opens them on the phone. Without one, only the brief line goes out.
  key?: string
  deviceId?: string
  createdAt: string
}
type Saved = {
  publicKey: string
  privateKey: string
  subscriptions: Subscription[]
  apps: AppDevice[]
}
// title/body: shown by Web Push (encrypted to the browser). brief: what the native app's
// notification says instead, since Apple can read APNs messages (no title or project).
export type PushPayload = { title: string; body: string; url: string; tag: string; brief: string }
// What sends one message; tests pass a stand-in. Resolves, or rejects with the push service's
// status code when it has one.
export type PushSender = (
  subscription: Subscription,
  payload: string,
  options: { vapidDetails: { subject: string; publicKey: string; privateKey: string } } & Record<
    string,
    unknown
  >,
) => Promise<unknown>

const maxSubscriptions = 50
// Subscribe input: what PushSubscription.toJSON() gives, with sizes bounded.
export const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z
      .string()
      .regex(/^[\w-]+=*$/)
      .max(200),
    auth: z
      .string()
      .regex(/^[\w-]+=*$/)
      .max(100),
  }),
})

// The browsers' push services. Anything else is refused, so the server only ever contacts these.
const pushHosts = [
  /^web\.push\.apple\.com$/,
  /^[\w-]+\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[\w-]+\.push\.services\.mozilla\.com$/,
  /^[\w.-]+\.notify\.windows\.com$/,
]
export const appDeviceSchema = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{64,200}$/),
  environment: z.enum(['sandbox', 'production']),
  topic: z
    .string()
    .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/)
    .max(155),
  key: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/)
    .refine((value) => Buffer.from(value, 'base64').length === 32)
    .optional(),
})

// The notification's real text, sealed for the phone: AES-256-GCM with the app's key, as
// base64(nonce · ciphertext · tag), the layout CryptoKit's AES.GCM.SealedBox(combined:) reads.
export function sealForApp(key: string, content: { title: string; body: string }) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce)
  const sealed = Buffer.concat([cipher.update(JSON.stringify(content), 'utf8'), cipher.final()])
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64')
}
export function allowedPushHost(endpoint: string) {
  try {
    const url = new URL(endpoint)
    return (
      url.protocol === 'https:' &&
      (url.port === '' || url.port === '443') &&
      !url.username &&
      !url.password &&
      pushHosts.some((host) => host.test(url.hostname))
    )
  } catch {
    return false
  }
}

export class PushNotifications {
  private saved?: Saved
  private sending = new Set<Promise<unknown>>()
  constructor(
    readonly path: string,
    private options: {
      // Whether a paired device still exists (revoked or expired: no more pushes for it).
      deviceExists?: (id: string) => boolean | Promise<boolean>
      send?: PushSender
      subject?: string
      // The native app: the APNs key (null while it isn't set up) and what sends.
      apns?: { config: () => Promise<ApnsConfig | null>; send: ApnsSender }
    } = {},
  ) {}

  private async load() {
    if (this.saved) return this.saved
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as Partial<Saved>
      if (typeof data.publicKey === 'string' && typeof data.privateKey === 'string')
        this.saved = {
          publicKey: data.publicKey,
          privateKey: data.privateKey,
          subscriptions: Array.isArray(data.subscriptions)
            ? data.subscriptions.filter((item) => allowedPushHost(item?.endpoint ?? ''))
            : [],
          apps: Array.isArray(data.apps)
            ? data.apps.filter((item) => appDeviceSchema.safeParse(item).success)
            : [],
        }
    } catch {
      // Missing or unreadable: make new keys (old subscriptions can't be used with them anyway).
    }
    if (!this.saved) {
      const keys = generateVAPIDKeys()
      this.saved = {
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        subscriptions: [],
        apps: [],
      }
      await this.save()
    }
    return this.saved
  }
  private async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(this.path + '.tmp', JSON.stringify(this.saved), { mode: 0o600 })
    await rename(this.path + '.tmp', this.path)
  }

  // For the browser's pushManager.subscribe (applicationServerKey). Public by design.
  async publicKey() {
    return (await this.load()).publicKey
  }
  async subscribe(input: unknown, deviceId?: string) {
    const data = subscriptionSchema.parse(input)
    if (!allowedPushHost(data.endpoint)) throw new Error('Unsupported push service.')
    const saved = await this.load()
    saved.subscriptions = saved.subscriptions.filter((item) => item.endpoint !== data.endpoint)
    saved.subscriptions.push({
      endpoint: data.endpoint,
      keys: data.keys,
      ...(deviceId ? { deviceId } : {}),
      createdAt: new Date().toISOString(),
    })
    // Bounded: the oldest go first.
    saved.subscriptions = saved.subscriptions.slice(-maxSubscriptions)
    await this.save()
  }
  async unsubscribe(endpoint: string) {
    const saved = await this.load()
    const before = saved.subscriptions.length
    saved.subscriptions = saved.subscriptions.filter((item) => item.endpoint !== endpoint)
    if (saved.subscriptions.length !== before) await this.save()
  }
  async subscribed(endpoint: string) {
    return (await this.load()).subscriptions.some((item) => item.endpoint === endpoint)
  }
  // The native app on a device registers its APNs token (POST /api/push/app).
  async registerApp(input: unknown, deviceId?: string) {
    const data = appDeviceSchema.parse(input)
    const token = data.token.toLowerCase()
    const saved = await this.load()
    saved.apps = saved.apps.filter((item) => item.token !== token)
    saved.apps.push({
      ...data,
      token,
      ...(deviceId ? { deviceId } : {}),
      createdAt: new Date().toISOString(),
    })
    saved.apps = saved.apps.slice(-maxSubscriptions)
    await this.save()
  }
  async unregisterApp(token: string) {
    const saved = await this.load()
    const before = saved.apps.length
    saved.apps = saved.apps.filter((item) => item.token !== token.toLowerCase())
    if (saved.apps.length !== before) await this.save()
  }
  async appRegistered(token: string) {
    return (await this.load()).apps.some((item) => item.token === token.toLowerCase())
  }
  async apnsConfigured() {
    return Boolean(await this.options.apns?.config())
  }
  // A device was revoked (or all of them, without an id): its subscriptions go too.
  async removeDevice(id?: string) {
    const saved = await this.load()
    const before = saved.subscriptions.length + saved.apps.length
    const keep = (item: { deviceId?: string }) => (id ? item.deviceId !== id : !item.deviceId)
    saved.subscriptions = saved.subscriptions.filter(keep)
    saved.apps = saved.apps.filter(keep)
    if (saved.subscriptions.length + saved.apps.length !== before) await this.save()
  }

  // To the native app: the brief line Apple can read, the thread to open, and (with the app's
  // key) the real title and project sealed so only the phone can read them.
  private async sendApp(app: AppDevice, payload: PushPayload) {
    const apns = this.options.apns
    const config = await apns?.config()
    if (!apns || !config) return 'failed' as const
    return apns.send(config, {
      token: app.token,
      environment: app.environment,
      topic: app.topic,
      collapseId: payload.tag,
      payload: {
        aps: {
          alert: { title: 't3 mini', body: payload.brief },
          sound: 'default',
          'thread-id': 't3mini',
          // Lets the app's extension swap in the sealed title and project before it's shown.
          ...(app.key ? { 'mutable-content': 1 } : {}),
        },
        url: payload.url,
        ...(app.key
          ? { sealed: sealForApp(app.key, { title: payload.title, body: payload.body }) }
          : {}),
      },
    })
  }

  // Sends to every subscription (encrypted for each). Subscriptions the push service says are
  // gone (404, 410) are dropped; ones from devices that no longer exist are skipped and dropped.
  // `skip`: browser subscriptions not to send to (you're using t3 mini there right now).
  async send(payload: PushPayload, skip: ReadonlySet<string> = new Set()) {
    const saved = await this.load()
    const send = this.options.send ?? (sendNotification as unknown as PushSender)
    const gone = new Set<string>()
    await Promise.all(
      saved.subscriptions.map(async (subscription) => {
        if (subscription.deviceId && !(await this.options.deviceExists?.(subscription.deviceId))) {
          gone.add(subscription.endpoint)
          return
        }
        if (skip.has(subscription.endpoint)) return
        try {
          await send(subscription, JSON.stringify(payload), {
            vapidDetails: {
              subject:
                this.options.subject ??
                process.env.T3_MINI_PUSH_SUBJECT ??
                'mailto:t3mini@example.com',
              publicKey: saved.publicKey,
              privateKey: saved.privateKey,
            },
            TTL: 24 * 60 * 60,
            urgency: 'high',
            // One notification per thread at a time: a newer one replaces it on the device.
            topic: payload.tag.replace(/[^\w-]/g, '').slice(0, 32),
            timeout: 10_000,
          })
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) gone.add(subscription.endpoint)
        }
      }),
    )
    const goneApps = new Set<string>()
    await Promise.all(
      saved.apps.map(async (app) => {
        if (app.deviceId && !(await this.options.deviceExists?.(app.deviceId))) {
          goneApps.add(app.token)
          return
        }
        if ((await this.sendApp(app, payload)) === 'gone') goneApps.add(app.token)
      }),
    )
    if (gone.size || goneApps.size) {
      saved.subscriptions = saved.subscriptions.filter((item) => !gone.has(item.endpoint))
      saved.apps = saved.apps.filter((item) => !goneApps.has(item.token))
      await this.save()
    }
  }
  // A test to one app device (the app's Settings → Send a test).
  async sendAppTest(token: string, payload: PushPayload) {
    const app = (await this.load()).apps.find((item) => item.token === token.toLowerCase())
    if (!app) return 'missing' as const
    return this.sendApp(app, payload)
  }
  // A test message to one subscription (Settings → Send a test).
  async sendTest(endpoint: string, payload: PushPayload) {
    const saved = await this.load()
    const subscription = saved.subscriptions.find((item) => item.endpoint === endpoint)
    if (!subscription) return false
    const send = this.options.send ?? (sendNotification as unknown as PushSender)
    await send(subscription, JSON.stringify(payload), {
      vapidDetails: {
        subject:
          this.options.subject ?? process.env.T3_MINI_PUSH_SUBJECT ?? 'mailto:t3mini@example.com',
        publicKey: saved.publicKey,
        privateKey: saved.privateKey,
      },
      TTL: 60,
      urgency: 'high',
      timeout: 10_000,
    })
    return true
  }
  // Sends in the background, tracked so tests (and shutdown) can wait for it.
  queue(payload: PushPayload, skip?: ReadonlySet<string>) {
    const task = this.send(payload, skip).catch(() => {})
    this.sending.add(task)
    void task.finally(() => this.sending.delete(task))
  }
  async idle() {
    await Promise.all(this.sending)
  }
}

// What a thread event says on the lock screen: the thread's title, then what happened and where.
export function pushFor(event: ThreadEvent, project: string): PushPayload {
  const what = event.kind === 'completed' ? 'Done' : eventLabel(event)
  return {
    title: event.thread.title || 'Thread',
    body: `${what} · ${project}`,
    url: `/threads/${encodeURIComponent(event.thread.id)}`,
    tag: event.thread.id,
    brief:
      event.kind === 'completed'
        ? 'A thread finished.'
        : event.kind === 'failed'
          ? 'A thread failed.'
          : event.thread.waitingFor === 'secret'
            ? 'A thread needs a secret from you.'
            : event.thread.waitingFor === 'question'
              ? 'A thread has a question for you.'
              : 'A thread needs your approval.',
  }
}

// Watches the thread list (the same events the web app turns into notifications) and pushes
// finished, failed, and waiting threads you aren't looking at. Stopped ones aren't pushed: you
// stopped them. Changes come in bursts while a reply streams, so it checks at most twice a second.
export function watchThreads(
  service: {
    subscribe: (listener: () => void) => () => void
    list: () => ThreadSummary[]
    isWatching: (threadId: string) => boolean
    projectName: (cwd: string) => string
    // Browsers you're using t3 mini in right now: no push there (the page shows it already).
    pushInUse?: () => ReadonlySet<string>
    // An event for a thread you were looking at (not pushed), e.g. to mark it read.
    watched?: (event: ThreadEvent) => void
  },
  push: Pick<PushNotifications, 'queue'>,
  delay = 500,
) {
  let previous = new Map<string, Status>(service.list().map((item) => [item.id, item.status]))
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    timer = undefined
    const threads = service.list()
    for (const event of threadEvents(previous, threads)) {
      if (event.kind === 'interrupted' || event.thread.parentId) continue
      if (service.isWatching(event.thread.id)) {
        service.watched?.(event)
        continue
      }
      push.queue(pushFor(event, service.projectName(event.thread.cwd)), service.pushInUse?.())
    }
    previous = new Map(threads.map((item) => [item.id, item.status]))
  }
  const unsubscribe = service.subscribe(() => {
    timer ??= setTimeout(check, delay)
  })
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}

// One per server process (kept across dev reloads, like the phone gateway).
const globals = globalThis as typeof globalThis & { t3MiniPush?: PushNotifications }
export function getPush(
  path: string,
  deviceExists: (id: string) => Promise<boolean>,
  apns?: { config: () => Promise<ApnsConfig | null>; send: ApnsSender },
) {
  return (globals.t3MiniPush ??= new PushNotifications(path, {
    deviceExists,
    ...(apns ? { apns } : {}),
  }))
}

// The push store for a data folder: Web Push and the native app, with paired devices checked
// against the phone gateway's devices, and the APNs key read from apns.json when it's set.
export function pushIn(data: string) {
  return getPush(
    join(data, 'push.json'),
    async (id) => (await getRemoteAccess(join(data, 'devices.json'))).devices.has(id),
    { config: () => readApnsConfig(join(data, 'apns.json')), send: createApnsSender() },
  )
}
