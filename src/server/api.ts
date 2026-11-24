import { createHash } from 'node:crypto'
import { z } from 'zod'
import { activitiesFor, getService, HttpError } from './service'
import { ThreadDiff } from '../thread-patch'
import { pickProjectFolder } from './folder-picker'
import { getModels } from './models'
import { dirname, join } from 'node:path'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { mediaType } from './uploads'
import {
  loadLibraries,
  pageDocument,
  pageLibraries,
  previewTokens,
  themeCss,
  type PageLibrary,
} from '../html-page'
import QRCode from 'qrcode'
import { getRemoteAccess, remoteHeader, transportHeader } from './remote'
import { pushIn } from './push'
import { readApnsConfig, writeApnsConfig } from './apns'
import { defaultStorePath } from './store'
import { getMachines, isMachineError } from './machines'
import { parseHubId } from './hub-watch'
import { tailscaleStatus } from './tailscale'
import { providerAccount } from './accounts'
import {
  clearDictationKey,
  dictationAvailable,
  dictationDirect,
  dictationLive,
  dictationToken,
  dictationStatus,
  setDictationProvider,
  loadDictationKey,
  maxAudioBytes,
  saveDictationKey,
  transcribe,
  transcriptionThread,
} from './dictation'
import { registerDictationStream } from './dictation-stream'
import {
  latestProviderUpdates,
  onProviderUpdates,
  providerUpdates,
  updateProvider,
} from './cli-updates'
import { appUpdate, latestAppUpdate, onAppUpdate, restartApp, restartWhenIdle } from './app-update'

// Live dictation is a WebSocket, which the HTTP servers route to this module (see vite.config.ts
// and server.mjs).
registerDictationStream()

// This application launches local agents. Keep every endpoint loopback-only and same-origin.
// The push notifications store, next to the other data (one per process).
const pushFor = () => pushIn(dirname(defaultStorePath()))
export function checkRequest(request: Request) {
  const url = new URL(request.url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new HttpError(403, 't3 mini is available only on localhost.')
  const origin = request.headers.get('origin')
  if (origin && origin !== url.origin)
    throw new HttpError(403, 'Cross-origin requests are not allowed.')
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new HttpError(403, 'Cross-site requests are not allowed.')
  if (
    request.method !== 'GET' &&
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    throw new HttpError(415, 'Expected application/json.')
}
// Checked by shape, not instanceof: in dev the long-lived service was created by an earlier
// copy of service.ts, so after a hot reload its HttpError is a different class than the one
// imported here, and instanceof would turn every 404/409 into a generic 500.
export function isHttpError(error: unknown): error is HttpError {
  return (
    error instanceof Error &&
    ['HttpError', 'DictationError', 'UpdateError'].some(
      (name) => error.name === name || error.constructor.name === name,
    ) &&
    typeof (error as { status?: unknown }).status === 'number'
  )
}
// A streaming reply bumps its thread's updatedAt on every update, which would resend the whole
// thread list to every tab ten times a second, though the sidebar shows those times to the
// minute. A list that differs from the last one sent only in updatedAt waits up to
// `listTimesEvery`; any other change (status, title, unread, a new thread) goes out at once.
export const listTimesEvery = 5_000
// Updates a live-update stream may have waiting for a reader (~20 s of a streaming reply).
export const maxQueuedUpdates = 200
// The list's JSON without its updatedAt values. In JSON a quote inside a string is escaped, so
// the pattern only ever matches the field itself. One per notification (all tabs share it).
let lastList: { json: string; shape: string } | undefined
const listShape = (json: string) => {
  if (lastList?.json !== json) lastList = { json, shape: json.replace(/"updatedAt":"[^"]*"/g, '') }
  return lastList.shape
}
export class ListPacer {
  private shape?: string
  private sentAt = -Infinity
  // True: leave the list (its JSON, as sent) out of this update.
  hold(json: string, now = Date.now()) {
    const shape = listShape(json)
    if (shape === this.shape && now - this.sentAt < listTimesEvery) return true
    this.shape = shape
    this.sentAt = now
    return false
  }
}
// A file's bytes as a response body without copying them (new Uint8Array(buffer) copies; this
// is a view of the same memory, typed the way Response accepts).
const bodyOf = (bytes: Uint8Array) =>
  new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
// Live updates send each tab only the parts of the snapshot that changed since its last update
// (the whole snapshot on connect). While another thread streams, a tab gets its thread list but
// not its own open thread again, and nothing at all when none of its parts changed. Missing keys
// mean "unchanged". `sent` is the connection's memory: each part as last sent.
// extra: parts sent as they are, every time (already diffed, like the open thread's patch).
export function changedParts(
  sent: Map<string, string>,
  snapshot: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  stringify: (value: unknown) => string = (value) => JSON.stringify(value ?? null),
) {
  const parts: string[] = []
  for (const [key, value] of Object.entries(snapshot)) {
    const json = stringify(value)
    if (sent.get(key) === json) continue
    sent.set(key, json)
    parts.push(`${JSON.stringify(key)}:${json}`)
  }
  for (const [key, value] of Object.entries(extra))
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value ?? null)}`)
  return parts.length ? `{${parts.join(',')}}` : undefined
}
// One saved video or sound, whole or the byte range asked for ("bytes=START-END", "bytes=START-",
// or "bytes=-SUFFIX"). Served only with its own media type, no sniffing, and no scripts.
export async function serveMedia(
  uploads: { mediaPath: (id: string) => string },
  id: string,
  range: string | null,
) {
  let path: string
  let size: number
  try {
    path = uploads.mediaPath(id)
    size = (await stat(path)).size
  } catch {
    return Response.json({ error: 'Media not found.' }, { status: 404 })
  }
  const headers: Record<string, string> = {
    'Content-Type': mediaType(id),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  }
  const stream = (start: number, end: number) =>
    Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (!range || !match || (!match[1] && !match[2]) || !size)
    return new Response(size ? stream(0, size - 1) : null, {
      headers: { ...headers, 'Content-Length': String(size) },
    })
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!match[1]) end = size - 1
  if (start > end || start >= size)
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    })
  return new Response(stream(start, end), {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
    },
  })
}
// The ports of the dev servers t3 mini is running (the local URL each one printed).
function devServerPorts(processes: { status: string; url?: string; urls?: string[] }[]) {
  return processes
    .filter((item) => item.status === 'running')
    .flatMap((item) => item.urls ?? (item.url ? [item.url] : []))
    .map((url) => Number(new URL(url).port))
    .filter(Boolean)
}
const watchedPreviews = new WeakSet<object>()
// Live updates: every open tab handles the same notification, so they share one snapshot per
// thread and serialize each object once (not once per tab). Kept for one notification only: a
// new one (service.version) or the next microtask starts over.
let shared:
  | {
      version: number
      snapshots: Map<string, ReturnType<Service['snapshot']>>
      json: WeakMap<object, string>
    }
  | undefined
type Service = Awaited<ReturnType<typeof getService>>
function sharedUpdate(service: Service) {
  if (!shared || shared.version !== service.version) {
    const current = { version: service.version, snapshots: new Map(), json: new WeakMap() }
    shared = current
    queueMicrotask(() => {
      if (shared === current) shared = undefined
    })
  }
  return shared
}
function sharedSnapshot(service: Service, id: string | undefined) {
  const update = sharedUpdate(service)
  let snapshot = update.snapshots.get(id ?? '')
  if (!snapshot) update.snapshots.set(id ?? '', (snapshot = service.snapshot(id)))
  return snapshot
}
function sharedJson(service: Service, value: unknown) {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value ?? null)
  const cache = sharedUpdate(service).json
  let json = cache.get(value)
  if (json === undefined) cache.set(value, (json = JSON.stringify(value)))
  return json
}
export async function handleApi(request: Request) {
  try {
    checkRequest(request)
    const service = await getService()
    const url = new URL(request.url),
      parts = url.pathname.split('/').filter(Boolean).slice(1)
    // Set only by the phone-access gateway, which strips it from what the phone sends.
    const remote = request.headers.get(remoteHeader) === '1'
    const macOnly = (what: string) => {
      if (remote) throw new HttpError(403, `${what} is only available on the Mac running t3 mini.`)
    }
    const secretsPath = join(dirname(service.store.path), 'secrets.json')
    await loadDictationKey(secretsPath)
    // Other machines (machines.ts): their local addresses open with the first request.
    const machines = getMachines(join(dirname(service.store.path), 'machines.json'))
    // The hub: a machine's threads in this sidebar. /api/m/<machine>/<path> goes to that machine's
    // /api/<path> with its session (machines.ts forward(); only thread-related paths).
    if (parts[0] === 'm' && parts[1] && parts[2]) {
      // A secret for a machine's thread (request_secret) from a paired device: like this
      // computer's own secret route, only over HTTPS, so it never crosses the local network in
      // plain text on its way to the machine.
      if (
        remote &&
        parts[2] === 'threads' &&
        parts[4] === 'secret' &&
        request.headers.get(transportHeader) !== 'https'
      )
        throw new HttpError(
          403,
          'Secrets can only be sent from this device over HTTPS (Tailscale). Enter it on the computer instead.',
        )
      const prefix = `/api/m/${parts[1]}/`
      return await machines.forward(
        decodeURIComponent(parts[1]),
        url.pathname.slice(prefix.length),
        request,
      )
    }
    // The hub for paired devices (the iPhone app): the machines that are online, by id and name
    // only, so it can show their threads through /api/m/<machine>/ like this computer's sidebar.
    // Never their addresses or sessions; adding and removing machines stays Mac-only.
    if (parts[0] === 'machines' && parts[1] === 'hub' && !parts[2] && request.method === 'GET') {
      const list = await machines.list()
      return Response.json(
        list
          .filter((machine) => machine.status === 'online')
          .map((machine) => ({ id: machine.id, name: machine.name })),
      )
    }
    if (parts[0] === 'machines') {
      macOnly('Managing machines')
      const body = request.method === 'GET' ? null : ((await request.json()) as unknown)
      const input = z
        .object({
          id: z.string().max(100).optional(),
          link: z.string().max(2000).optional(),
          name: z.string().max(60).optional(),
        })
        .parse(body ?? {})
      try {
        if (!parts[1] && request.method === 'GET') return Response.json(await machines.list())
        if (!parts[1] && request.method === 'POST') {
          const added = await machines.add({ link: input.link ?? '', name: input.name })
          return Response.json({ id: added.id, name: added.name }, { status: 201 })
        }
        if (!parts[1] && request.method === 'DELETE' && input.id) {
          await machines.remove(input.id)
          return Response.json({ ok: true })
        }
        if (parts[1] === 'rename' && request.method === 'POST' && input.id) {
          const renamed = await machines.rename(input.id, input.name ?? '')
          return Response.json({ id: renamed.id, name: renamed.name })
        }
      } catch (error) {
        if (isMachineError(error)) throw new HttpError(400, error.message)
        throw error
      }
      throw new HttpError(404, 'Not found.')
    }
    // Open a dev server that runs on this Mac on the paired device asking (see previews.ts).
    // Only from a paired device (the Mac can open localhost itself), and only for the port of a
    // dev server t3 mini is running, never any other local service.
    if (parts[0] === 'previews' && !parts[1] && request.method === 'POST') {
      const device = request.headers.get('x-t3-device')
      if (!remote || !device)
        throw new HttpError(
          403,
          'Previews are for paired devices: on this Mac, open the address directly.',
        )
      const { port, path } = z
        .object({
          port: z.number().int().min(1).max(65_535),
          path: z.string().max(2000).optional(),
        })
        .parse(await request.json())
      const running = devServerPorts(service.processes.list())
      if (!running.includes(port))
        throw new HttpError(404, `Nothing t3 mini started is running on :${port}.`)
      const access = await getRemoteAccess(join(dirname(service.store.path), 'devices.json'))
      // Previews close when their dev server stops (watched once per gateway).
      if (!watchedPreviews.has(access)) {
        watchedPreviews.add(access)
        service.processes.subscribe(
          () => void access.previews.keepOnly(devServerPorts(service.processes.list())),
        )
      }
      await access.previews.keepOnly(running)
      try {
        return Response.json(await access.previews.open(port, device, path))
      } catch (error) {
        throw new HttpError(
          (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 409 : 500,
          (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
            ? `Port ${port + 10_000} is in use, so this dev server can’t be previewed.`
            : error instanceof Error
              ? error.message
              : 'Could not open the preview.',
        )
      }
    }
    // Dictation keys (Deepgram, AssemblyAI) and which one is used: managed from the Mac only,
    // and never returned.
    if (parts[0] === 'dictation' && !parts[1]) {
      macOnly('Managing the dictation key')
      if (request.method === 'GET') return Response.json(dictationStatus())
      if (request.method === 'POST')
        return Response.json(await saveDictationKey(secretsPath, await request.json()))
      if (request.method === 'DELETE')
        return Response.json(
          await clearDictationKey(secretsPath, await request.json().catch(() => ({}))),
        )
    }
    // A Dictation-only AssemblyAI token for the iPhone app, to send its recording straight to
    // AssemblyAI. From a phone only over HTTPS (the token is a credential, if a short-lived one).
    if (parts[0] === 'dictation' && parts[1] === 'token' && request.method === 'POST') {
      if (remote && request.headers.get(transportHeader) !== 'https')
        throw new HttpError(403, 'Dictation tokens are only sent over an encrypted connection.')
      const body = z
        .object({ thread: z.string().max(100).optional() })
        .safeParse(await request.json().catch(() => ({})))
      const thread = body.success ? body.data.thread : undefined
      const keyterms = thread ? await service.dictationKeyterms(thread).catch(() => []) : []
      return Response.json(await dictationToken(keyterms))
    }
    if (parts[0] === 'dictation' && parts[1] === 'provider' && request.method === 'POST') {
      macOnly('Choosing the dictation service')
      return Response.json(await setDictationProvider(secretsPath, await request.json()))
    }
    if (parts[0] === 'transcribe' && !parts[1] && request.method === 'POST') {
      // base64 + JSON overhead on top of the audio limit; refuse bigger bodies before reading.
      const length = Number(request.headers.get('content-length') || 0)
      if (length > Math.ceil(maxAudioBytes * 1.4))
        throw new HttpError(413, 'The recording is too long.')
      const body = await request.json()
      const thread = transcriptionThread(body)
      // The thread's words only help spelling: without them, still transcribe (as live does).
      const keyterms = thread ? await service.dictationKeyterms(thread).catch(() => []) : []
      return Response.json(await transcribe(body, keyterms))
    }
    // Long-running processes agents started (the list itself comes with the live updates).
    if (parts[0] === 'processes' && parts[1]) {
      const info = service.processes.get(parts[1])
      if (!info) throw new HttpError(404, 'Process not found.')
      if (parts[2] === 'logs' && request.method === 'GET') {
        const lines = Number(url.searchParams.get('lines')) || 500
        return Response.json({ logs: service.processes.logs(info.id, lines) ?? '' })
      }
      if (parts[2] === 'stop' && request.method === 'POST')
        return Response.json(await service.processes.stop(info.id))
      if (parts[2] === 'restart' && request.method === 'POST')
        return Response.json(await service.processes.restart(info.id))
      if (!parts[2] && request.method === 'DELETE') {
        try {
          service.processes.remove(info.id)
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : 'Stop it first.')
        }
        return Response.json({ ok: true })
      }
    }
    if (parts[0] === 'remote') {
      macOnly('Managing phone access')
      const access = await getRemoteAccess(join(dirname(service.store.path), 'devices.json'))
      // Status plus whether Tailscale can be used (installed, signed in, its tailnet name).
      const status = async () => ({ ...access.status(), tailscale: await tailscaleStatus() })
      if (!parts[1] && request.method === 'GET') return Response.json(await status())
      if (!parts[1] && request.method === 'POST') {
        const { enabled, mode } = z
          .object({ enabled: z.boolean(), mode: z.enum(['lan', 'tailscale']).default('lan') })
          .parse(await request.json())
        try {
          await access.set(enabled, Number(url.port) || 80, mode)
        } catch (error) {
          throw new HttpError(
            500,
            (error as NodeJS.ErrnoException).code === 'EADDRINUSE' || !(error instanceof Error)
              ? `Could not start phone access on port ${access.port}. Is another app using it?`
              : error.message,
          )
        }
        return Response.json(await status())
      }
      if (parts[1] === 'settings' && request.method === 'POST') {
        const { autoResume } = z.object({ autoResume: z.boolean() }).parse(await request.json())
        await access.setAutoResume(autoResume)
        return Response.json(await status())
      }
      // Sent by the server itself once it's listening (vite.config.ts, server.mjs).
      if (parts[1] === 'resume' && request.method === 'POST') {
        access.resume(Number(url.port) || 80)
        return Response.json({ ok: true })
      }
      if (parts[1] === 'pair' && request.method === 'POST') {
        let pairing
        try {
          pairing = access.createPairing()
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : 'Phone access is off.')
        }
        const links = await Promise.all(
          pairing.urls.map(async (link) => ({
            url: link,
            qr: await QRCode.toDataURL(link, { margin: 1, width: 240 }),
          })),
        )
        return Response.json({ expiresAt: pairing.expiresAt, links })
      }
      if (parts[1] === 'devices' && request.method === 'DELETE') {
        const { id } = z.object({ id: z.string().optional() }).parse(await request.json())
        await access.revoke(id)
        // Its push notifications stop too (all paired devices' when revoking all).
        await pushFor().removeDevice(id)
        await activitiesFor(await getService()).removeDevice(id)
        return Response.json(await status())
      }
    }
    // Push notifications (push.ts): the server's public key for subscribing, subscribe and
    // unsubscribe this browser, and a test message. A paired device's subscription belongs to it
    // (the gateway's x-t3-device, trusted only on gateway requests), so revoking it stops them.
    if (parts[0] === 'push') {
      const push = pushFor()
      if (!parts[1] && request.method === 'GET') {
        const endpoint = url.searchParams.get('endpoint')
        return Response.json({
          publicKey: await push.publicKey(),
          subscribed: endpoint ? await push.subscribed(endpoint) : false,
        })
      }
      if (!parts[1] && request.method === 'POST') {
        const deviceId = remote ? request.headers.get('x-t3-device') || undefined : undefined
        try {
          await push.subscribe(await request.json(), deviceId)
        } catch (error) {
          if (error instanceof z.ZodError) throw error
          throw new HttpError(400, 'This browser’s push service isn’t supported.')
        }
        return Response.json({ ok: true })
      }
      if (!parts[1] && request.method === 'DELETE') {
        const { endpoint } = z
          .object({ endpoint: z.string().max(2048) })
          .parse(await request.json())
        await push.unsubscribe(endpoint)
        return Response.json({ ok: true })
      }
      // The native iOS app (apns.ts): register this device's APNs token, check it, remove it, and
      // a test. The device is the paired one asking (gateway requests only).
      if (parts[1] === 'app') {
        const deviceId = remote ? request.headers.get('x-t3-device') || undefined : undefined
        if (!parts[2] && request.method === 'GET') {
          const token = url.searchParams.get('token') ?? ''
          return Response.json({
            configured: await push.apnsConfigured(),
            registered: token ? await push.appRegistered(token) : false,
          })
        }
        if (!parts[2] && request.method === 'POST') {
          await push.registerApp(await request.json(), deviceId)
          return Response.json({ ok: true, configured: await push.apnsConfigured() })
        }
        if (!parts[2] && request.method === 'DELETE') {
          const { token } = z.object({ token: z.string().max(200) }).parse(await request.json())
          await push.unregisterApp(token)
          return Response.json({ ok: true })
        }
        if (parts[2] === 'test' && !parts[3] && request.method === 'POST') {
          const { token } = z.object({ token: z.string().max(200) }).parse(await request.json())
          if (!(await push.apnsConfigured()))
            throw new HttpError(409, 'Push isn’t set up on the computer yet (its Apple push key).')
          const result = await push.sendAppTest(token, {
            title: 't3 mini',
            body: 'Notifications work.',
            url: '/',
            tag: 'test',
            brief: 'Notifications work. You’ll get one when a thread finishes or needs you.',
          })
          if (result === 'missing')
            throw new HttpError(
              404,
              'This iPhone isn’t registered. Turn notifications off and on again.',
            )
          if (result !== 'sent')
            throw new HttpError(502, 'Apple didn’t accept the message. Try again.')
          return Response.json({ ok: true })
        }
      }
      // A Live Activity the native app started for a thread (live-activities.ts): register its
      // push token, or remove it. The device is the paired one asking (gateway requests only).
      if (parts[1] === 'activity' && !parts[2]) {
        const activities = activitiesFor(await getService())
        const deviceId = remote ? request.headers.get('x-t3-device') || undefined : undefined
        if (request.method === 'POST') {
          const body = (await request.json()) as { thread?: unknown }
          // A machine's thread: fetched now, and followed from then on (hub-watch.ts).
          if (typeof body?.thread === 'string' && parseHubId(body.thread))
            await (await getService()).hub?.load(body.thread)
          try {
            await activities.register(body, deviceId)
          } catch (error) {
            if (error instanceof z.ZodError) throw error
            throw new HttpError(404, 'Thread not found.')
          }
          activities.queue()
          return Response.json({ ok: true, configured: await push.apnsConfigured() })
        }
        if (request.method === 'DELETE') {
          const { token } = z.object({ token: z.string().max(400) }).parse(await request.json())
          await activities.unregister(token)
          return Response.json({ ok: true })
        }
      }
      // The Apple push key for the native app: set on this Mac only, never shown back.
      if (parts[1] === 'apns' && !parts[2]) {
        macOnly('Setting up push notifications')
        const path = join(dirname(defaultStorePath()), 'apns.json')
        if (request.method === 'GET') {
          const config = await readApnsConfig(path)
          return Response.json(
            config
              ? { configured: true, keyId: config.keyId, teamId: config.teamId }
              : { configured: false },
          )
        }
        if (request.method === 'POST') {
          const config = await writeApnsConfig(path, await request.json())
          return Response.json({ configured: true, keyId: config.keyId, teamId: config.teamId })
        }
      }
      if (parts[1] === 'test' && !parts[2] && request.method === 'POST') {
        const { endpoint } = z
          .object({ endpoint: z.string().max(2048) })
          .parse(await request.json())
        try {
          if (
            !(await push.sendTest(endpoint, {
              title: 't3 mini',
              body: 'Notifications work. You’ll get one when a thread finishes or needs you.',
              url: '/',
              tag: 'test',
              brief: 'Notifications work.',
            }))
          )
            throw new HttpError(
              404,
              'This browser isn’t subscribed. Turn notifications off and on again.',
            )
        } catch (error) {
          if (isHttpError(error)) throw error
          throw new HttpError(502, 'The push service didn’t accept the message. Try again.')
        }
        return Response.json({ ok: true })
      }
    }
    // Agent CLI updates: offered on every device (phones too, and other computers' hubs through
    // /api/m/<machine>/). Running one only starts the CLI's own fixed `update` command, so a
    // paired device, which can already run agents, gets nothing more than that.
    if (parts[0] === 'provider-updates') {
      if (!parts[1] && request.method === 'GET')
        return Response.json({
          updates: await providerUpdates(url.searchParams.get('refresh') === '1'),
        })
      if (parts[1] && !parts[2] && request.method === 'POST') {
        const provider = z.enum(['codex', 'claude']).parse(parts[1])
        const busy = service.busy(provider)
        return Response.json(await updateProvider(provider, busy))
      }
    }
    // A newer t3mini installed while this one runs (app-update.ts): restart onto it, now or
    // once no agent is working. From any paired device too, like agent updates.
    if (parts[0] === 'app-update') {
      if (!parts[1] && request.method === 'GET') return Response.json(await appUpdate())
      if (parts[1] === 'restart' && !parts[2] && request.method === 'POST') {
        const { when } = z
          .object({ when: z.enum(['now', 'idle', 'cancel']) })
          .parse(await request.json())
        if (!(await appUpdate()).ready) throw new HttpError(409, 'No update is waiting.')
        const busy = () => service.busy()
        if (when === 'now') {
          restartWhenIdle(false, busy)
          await restartApp()
        } else restartWhenIdle(when === 'idle', busy)
        return Response.json(await appUpdate())
      }
    }
    if (parts[0] === 'folders' && parts[1] === 'pick' && request.method === 'POST') {
      macOnly('Browsing folders')
      return Response.json(await pickProjectFolder(await request.json()))
    }
    // Command palette and sidebar search: threads whose conversations mention the query
    // (`limit`: how many, 20 by default, at most 500).
    if (parts[0] === 'search' && !parts[1] && request.method === 'GET')
      return Response.json({
        matches: service.searchMessages(
          url.searchParams.get('q') ?? '',
          url.searchParams.get('limit') ?? undefined,
        ),
      })
    // Who each agent is signed in as (email and plan), for Settings → Agents.
    if (parts[0] === 'providers' && parts[1] === 'accounts' && request.method === 'GET') {
      const refresh = url.searchParams.get('refresh') === '1'
      const [claude, codex] = await Promise.all([
        providerAccount('claude', refresh),
        providerAccount('codex', refresh),
      ])
      return Response.json({ claude, codex })
    }
    if (parts[0] === 'models' && request.method === 'GET') {
      const provider = z.enum(['codex', 'claude']).parse(url.searchParams.get('provider'))
      try {
        return Response.json({
          models: await getModels(
            provider,
            url.searchParams.get('cwd') || undefined,
            url.searchParams.get('refresh') === '1',
          ),
        })
      } catch {
        return Response.json({
          models: [],
          error:
            'Could not load models from this provider. Check your CLI installation and sign-in, or use Provider default.',
        })
      }
    }
    // An agent's HTML page (show_html), as plain text: the browser shows it only inside a
    // sandboxed frame. Opened directly, it's text, and sandboxed even if something sniffs it.
    // The finished page for an app without the web client's page builder (the iOS app): the same
    // pageDocument() the chat builds, with our CSP first, the theme's tokens, and any bundled
    // library the block asked for. Still plain text with a sandbox CSP, so a browser that opens it
    // directly never runs it; the app loads it into a sealed web view itself.
    if (
      parts[0] === 'html' &&
      parts[1] &&
      parts[2] === 'page' &&
      !parts[3] &&
      request.method === 'GET'
    ) {
      let html: string
      try {
        html = await service.uploads.readHtml(parts[1])
      } catch {
        return Response.json({ error: 'Page not found.' }, { status: 404 })
      }
      const dark = url.searchParams.get('theme') === 'dark'
      const libraries = (url.searchParams.get('libraries') ?? '')
        .split(',')
        .filter((name): name is PageLibrary => (pageLibraries as readonly string[]).includes(name))
      const page = pageDocument({
        html,
        theme: themeCss(previewTokens[dark ? 'dark' : 'light'], dark),
        inline: url.searchParams.get('inline') !== '0',
        still: url.searchParams.get('still') === '1',
        libraries: await loadLibraries([...new Set(libraries)]),
      })
      return new Response(page, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, max-age=3600',
        },
      })
    }
    if (parts[0] === 'html' && parts[1] && !parts[2] && request.method === 'GET') {
      let html: string
      try {
        html = await service.uploads.readHtml(parts[1])
      } catch {
        return Response.json({ error: 'Page not found.' }, { status: 404 })
      }
      return new Response(html, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, max-age=3600',
        },
      })
    }
    if (parts[0] === 'uploads') {
      if (!parts[1] && request.method === 'POST') {
        // Reject oversized bodies before reading them (25 MB file as base64, plus JSON).
        const length = Number(request.headers.get('content-length') || 0)
        if (length > 36 * 1024 * 1024) throw new HttpError(413, 'Files can be up to 25 MB.')
        return Response.json(await service.upload(await request.json()), { status: 201 })
      }
      // Only saved images are served (by generated id), with no sniffing and no scripts.
      if (parts[1] && !parts[2] && request.method === 'GET') {
        try {
          const { bytes, mimeType } = await service.uploads.read(parts[1])
          return new Response(bodyOf(bytes), {
            headers: {
              'Content-Type': mimeType,
              'Cache-Control': 'private, max-age=31536000, immutable',
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'",
            },
          })
        } catch {
          throw new HttpError(404, 'Image not found.')
        }
      }
    }
    // Videos and sounds the agent showed (show_video, play_audio), by generated id only. Streamed
    // with byte ranges: players seek with them, and Safari won't play video without them.
    if (parts[0] === 'media' && parts[1] && !parts[2] && request.method === 'GET')
      return serveMedia(service.uploads, parts[1], request.headers.get('range'))
    // Open tabs report focus, heartbeats, and closing, so one tab in all browsers notifies.
    if (parts[0] === 'tabs' && !parts[1] && request.method === 'POST') {
      const { id, event, viewing, watching, push } = z
        .object({
          id: z.string().regex(/^[a-z0-9-]{8,64}$/),
          event: z.enum(['visit', 'alive', 'leave']),
          viewing: z.string().max(100).optional(),
          watching: z.boolean().optional(),
          // Only ever used to skip pushes to it while you're in this tab, never to send.
          push: z.string().url().startsWith('https://').max(2048).optional(),
        })
        .parse(await request.json())
      service.tabs.report(id, event, Date.now(), {
        ...(viewing ? { viewing } : {}),
        ...(watching !== undefined ? { watching } : {}),
        ...(push ? { push } : {}),
      })
      return Response.json({ activeTab: service.tabs.leader() ?? null })
    }
    // View settings shared by every browser (Group by…).
    if (parts[0] === 'ui-settings' && !parts[1] && request.method === 'POST')
      return Response.json(await service.updateUi(await request.json()))
    // How often agents check UI changes in the browser (counts only; Settings → Agents).
    if (parts[0] === 'browser-stats' && !parts[1] && request.method === 'GET')
      return Response.json(service.browserStats.data)
    if (
      parts[0] === 'browser-stats' &&
      parts[1] === 'reset' &&
      !parts[2] &&
      request.method === 'POST'
    )
      return Response.json(service.browserStats.reset())
    if (parts[0] === 'ui-settings' && !parts[1] && request.method === 'GET')
      return Response.json(service.ui.settings)
    // A project's own icon for its sidebar avatar (only for projects listed in the sidebar).
    if (parts[0] === 'projects' && parts[1] === 'icon' && !parts[2] && request.method === 'GET') {
      const path = url.searchParams.get('path') ?? ''
      if (!service.projects().some((project) => project.path === path))
        return Response.json({ error: 'Project not found.' }, { status: 404 })
      const icon = await service.icons.read(path).catch(() => undefined)
      if (!icon) return Response.json({ error: 'No icon.' }, { status: 404 })
      // Stale-while-revalidate: after a while away the browser shows the copy it has at once and
      // checks for a newer one in the background (a 304 when it's the same), instead of the
      // letter flashing while every icon loads again.
      const etag = `"${createHash('sha256').update(icon.data).digest('base64url').slice(0, 22)}"`
      const caching = {
        'cache-control': 'private, max-age=300, stale-while-revalidate=2592000',
        etag,
      }
      if (request.headers.get('if-none-match') === etag)
        return new Response(null, { status: 304, headers: caching })
      return new Response(bodyOf(icon.data), {
        headers: {
          'content-type': icon.mimeType,
          ...caching,
          'x-content-type-options': 'nosniff',
          // An SVG opened directly could run scripts on this origin; this keeps it inert.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      })
    }
    if (parts[0] === 'projects' && parts[1] === 'rename' && !parts[2] && request.method === 'POST')
      return Response.json(await service.renameProject(await request.json()))
    if (parts[0] === 'projects' && parts[1] === 'avatar' && !parts[2] && request.method === 'POST')
      return Response.json(await service.setProjectAvatar(await request.json()))
    if (parts[0] === 'projects' && !parts[1]) {
      if (request.method === 'POST')
        return Response.json(await service.addProject(await request.json()), { status: 201 })
      if (request.method === 'DELETE')
        return Response.json(await service.removeProject(await request.json()))
    }
    if (parts[0] === 'bootstrap' && request.method === 'GET') {
      const access = await getRemoteAccess(join(dirname(service.store.path), 'devices.json'))
      // remote: this page runs on a paired phone, so Mac-only actions are hidden.
      return Response.json({
        ...(await service.bootstrap()),
        remote,
        phoneAccess: access.enabled,
        dictation: dictationAvailable(),
        // Words stream in while you talk (Deepgram); otherwise the recording goes whole on stop.
        dictationLive: dictationLive(),
        // The iPhone app may send its recording straight to AssemblyAI (POST /api/dictation/token).
        dictationDirect: dictationDirect(),
      })
    }
    if (parts[0] === 'events' && request.method === 'GET') {
      const id = url.searchParams.get('thread') || undefined
      if (id) service.get(id)
      // patch=1: the open thread comes whole once, then as patches (src/thread-patch.ts). Tabs
      // that don't ask (a hub running an older t3mini) get the whole thread when it changes.
      const patches = url.searchParams.get('patch') === '1'
      let cleanup = () => {}
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encode = new TextEncoder()
          const sent = new Map<string, string>()
          const diff = new ThreadDiff(
            (value) => sharedJson(service, value),
            url.searchParams.get('append') === '1',
          )
          const pacer = new ListPacer()
          const push = () => {
            try {
              const { thread, threads, ...snapshot } = sharedSnapshot(service, id)
              const changes = changedParts(
                sent,
                {
                  ...snapshot,
                  ...(pacer.hold(sharedJson(service, threads)) ? {} : { threads }),
                  ...(patches ? {} : { thread }),
                  // Updates (shown on every device, phones and other computers' hubs too): this
                  // server's agent CLIs (cli-updates.ts), a newer t3mini installed
                  // (app-update.ts), and those of the machines it follows (hub-watch.ts).
                  providerUpdates: latestProviderUpdates(),
                  appUpdate: latestAppUpdate(),
                  machineUpdates: service.hub?.updates?.() ?? [],
                },
                patches ? diff.next(thread) : undefined,
                (value) => sharedJson(service, value),
              )
              if (!changes) return
              // A tab that stopped reading (a stalled connection) would queue every update in
              // memory; end it instead. EventSource reconnects and gets the whole snapshot.
              if ((controller.desiredSize ?? 0) < -maxQueuedUpdates) return close()
              controller.enqueue(encode.encode(`data: ${changes}\n\n`))
            } catch {
              cleanup()
            }
          }
          const unsubscribe = service.subscribe(push)
          const unwatchApp = onAppUpdate(push)
          const unwatchProviders = onProviderUpdates(push)
          const unwatchMachines = service.hub?.onUpdates?.(push) ?? (() => {})
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encode.encode(': keepalive\n\n'))
            } catch {
              cleanup()
            }
          }, 15_000)
          cleanup = () => {
            unsubscribe()
            unwatchApp()
            unwatchProviders()
            unwatchMachines()
            clearInterval(heartbeat)
            request.signal.removeEventListener('abort', close)
          }
          const close = () => {
            cleanup()
            try {
              controller.close()
            } catch {
              /* Already closed. */
            }
          }
          request.signal.addEventListener('abort', close, { once: true })
          if (request.signal.aborted) close()
          else push()
        },
        cancel() {
          cleanup()
        },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      })
    }
    if (parts[0] === 'threads') {
      if (!parts[1] && request.method === 'POST')
        return Response.json(await service.create(await request.json()), { status: 201 })
      const id = parts[1]
      if (id && !parts[2] && request.method === 'GET') return Response.json(service.get(id))
      // The thread's agent browser: a fresh preview for the browser chip, or close it.
      if (id && parts[2] === 'browser' && parts[3] === 'preview' && request.method === 'GET') {
        service.get(id)
        const image = await service.browsers.preview(id).catch(() => undefined)
        if (!image) return Response.json({ error: 'No browser page is open.' }, { status: 404 })
        return new Response(bodyOf(image), {
          headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' },
        })
      }
      if (id && parts[2] === 'browser' && parts[3] === 'close' && request.method === 'POST') {
        service.get(id)
        await service.browsers.close(id)
        return Response.json({ ok: true })
      }
      if (id && parts[2] === 'read' && request.method === 'POST')
        return Response.json(await service.markRead(id))
      if (id && parts[2] === 'glance' && request.method === 'GET')
        return Response.json(service.glance(id))
      if (id && parts[2] === 'pull-request' && request.method === 'GET')
        return Response.json({ pullRequest: await service.pullRequest(id) })
      if (id && parts[2] === 'git' && request.method === 'GET')
        return Response.json(await service.gitInfo(id))
      if (id && parts[2] === 'diff' && !parts[3] && request.method === 'GET')
        return Response.json(await service.diff(id))
      if (id && parts[2] === 'diff' && parts[3] === 'version' && request.method === 'GET')
        return Response.json(await service.diffVersion(id))
      if (id && !parts[2] && request.method === 'DELETE')
        return Response.json(await service.remove(id))
      if (id && request.method === 'POST') {
        if (parts[2] === 'settings')
          return Response.json(await service.updateSettings(id, await request.json()))
        if (parts[2] === 'worktree')
          return Response.json(await service.setWorktree(id, await request.json()))
        if (parts[2] === 'send')
          return Response.json(await service.send(id, await request.json()), { status: 202 })
        if (parts[2] === 'edit')
          return Response.json(await service.edit(id, await request.json()), { status: 202 })
        if (parts[2] === 'open-editor') {
          macOnly('Opening VS Code')
          return Response.json(await service.openInEditor(id))
        }
        if (parts[2] === 'rename')
          return Response.json(await service.rename(id, await request.json()))
        if (parts[2] === 'title') return Response.json(await service.regenerateTitle(id))
        if (parts[2] === 'stop') return Response.json(await service.stop(id))
        // request_secret: the value you typed, straight to the env file (never stored, returned,
        // or logged). From a phone only over HTTPS (Tailscale): on the local network it would
        // cross the Wi-Fi unencrypted.
        if (parts[2] === 'secret') {
          if (remote && request.headers.get(transportHeader) !== 'https')
            throw new HttpError(
              403,
              'This connection isn’t encrypted, so secrets can’t be sent over it. Use phone access over Tailscale (HTTPS), or enter it on your computer.',
            )
          const body = z
            .object({ approvalId: z.string().max(200), value: z.string().max(16_384) })
            .safeParse(await request.json().catch(() => null))
          // A fixed message: zod's could quote the input.
          if (!body.success) throw new HttpError(400, 'That secret couldn’t be read.')
          return Response.json(
            await service.provideSecret(id, body.data.approvalId, body.data.value),
          )
        }
        if (parts[2] === 'approve') {
          const data = z
            .object({
              approvalId: z.string(),
              allow: z.boolean(),
              // Answers to an agent's question: question text → chosen option(s) or your words.
              answers: z
                .record(z.string().max(1000), z.string().max(4000))
                .refine((value) => Object.keys(value).length <= 8)
                .optional(),
            })
            .parse(await request.json())
          return Response.json(service.approve(id, data.approvalId, data.allow, data.answers))
        }
      }
    }
    throw new HttpError(404, 'Endpoint not found.')
  } catch (error) {
    const status = isHttpError(error)
      ? error.status
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? 400
        : 500
    const message = isHttpError(error)
      ? error.message
      : status === 400
        ? 'Invalid request. Check your input.'
        : 'The server could not complete the request.'
    return Response.json({ error: message }, { status })
  }
}
