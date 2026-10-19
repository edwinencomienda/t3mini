import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import {
  serveGateway,
  stopServingGateway,
  stopServingGatewayNow,
  tailscalePort,
  tailscaleStatus,
  type TailscaleStatus,
} from './tailscale'

// Phone access. A gateway runs only while switched on, lets in only paired devices, and forwards their requests to the loopback-only app, marked so the app knows
// they're remote. Two ways in:
// - Local network (plain HTTP): the gateway listens on the LAN.
// - Tailscale (HTTPS): the gateway listens on loopback only, and `tailscale serve` puts it
//   behind HTTPS on this Mac's tailnet name. Nothing is exposed on the LAN in this mode.
//
// Pairing: the Mac shows a QR code (or a link to copy) with a one-time code (5 minutes). The
// device trades it for a session cookie that lasts 30 days. Only hashes of codes and session
// tokens are kept. Opening the link (GET) only shows a "Connect this device" button; pressing it
// (POST) uses the code. Link previews (iMessage) and browsers preloading a pasted URL fetch the
// link before you do, and must not use up the code.
//
// After a restart it's off, except that Tailscale access you left on comes back by itself
// ("Reconnect after restart", on by default), so paired phones reconnect without you. Local
// network access never comes back on its own: it's plain HTTP on whatever network the Mac is
// on by then.

export const sessionDays = 30
const pairingMs = 5 * 60_000
const lanCookie = 't3m_session'
// HTTPS sessions use their own Secure cookie (the __Host- prefix requires it), so plain-HTTP
// and HTTPS sessions never mix.
const httpsCookie = '__Host-t3m_session'
export const remoteHeader = 'x-t3-remote'

export type Device = {
  id: string
  name: string
  tokenHash: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}
export type DeviceInfo = Omit<Device, 'tokenHash'>
export type PhoneMode = 'lan' | 'tailscale'
export type RemoteStatus = {
  enabled: boolean
  mode: PhoneMode
  port: number
  // What a phone connects to: LAN addresses, or the tailnet name.
  addresses: string[]
  // Tailscale mode: the HTTPS address, e.g. https://macbook.tail1234.ts.net:8443.
  url?: string
  devices: DeviceInfo[]
  // Turn Tailscale access back on after a restart if it was on.
  autoResume: boolean
  // Trying to turn it back on after a restart (Tailscale may still be starting).
  resuming: boolean
  resumeProblem?: string
}
// Saved next to the devices: the reconnect setting, and whether Tailscale access was on.
type Saved = { autoResume: boolean; wasOn: boolean }
// Waits between tries to turn Tailscale access back on after a restart (about 9 minutes).
const resumeDelays = [0, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
// What the gateway needs from Tailscale; tests pass a stand-in.
export type TailscaleControl = {
  status: () => Promise<TailscaleStatus>
  serve: (gatewayPort: number) => Promise<void>
  stopServe: (gatewayPort: number) => Promise<void>
  stopServeNow: () => void
  port: () => number
}
const tailscale: TailscaleControl = {
  status: tailscaleStatus,
  serve: serveGateway,
  stopServe: stopServingGateway,
  stopServeNow: stopServingGatewayNow,
  port: tailscalePort,
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const token = (bytes: number) => randomBytes(bytes).toString('base64url')

// Private and link-local IPv4 ranges (plus loopback); the gateway refuses anything else.
export function isPrivateAddress(address: string | undefined) {
  const ip = (address ?? '').replace(/^::ffff:/, '')
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(ip)
}
const isLoopback = (address: string | undefined) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')
// This machine's IPv4 addresses on private networks, e.g. your Wi-Fi address.
export function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item!.address)
    .filter((address) => isPrivateAddress(address))
}
function deviceName(userAgent = '') {
  const device = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Macintosh/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : 'Device'
  const browser = /CriOS|Chrome\//.test(userAgent)
    ? 'Chrome'
    : /FxiOS|Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Safari\//.test(userAgent)
        ? 'Safari'
        : ''
  return browser ? `${device} · ${browser}` : device
}
function cookies(header: string | undefined) {
  const values: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0) values[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return values
}
const page = (title: string, body: string, extra = '') =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t3 mini</title><body style="font:15px -apple-system,system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.25rem;color:#27272a;text-align:center"><h1 style="font-size:20px">${title}</h1><p style="color:#71717a">${body}</p>${extra}</body>`
// The gateway's own pages: inert (no scripts, no loads), not framable, and forms only post back
// here. Never cached, and the address (with its code) is never sent to another site as a
// referrer. Not 'no-referrer': with that, browsers send `Origin: null` on the Connect form's
// post, which allowed() rightly refuses as not this gateway (the "Forbidden" on phones).
const pageHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
}
// Pairing codes are token(18): 24 base64url characters.
const pairingCodeFormat = /^[\w-]{16,64}$/
const expiredPage = () =>
  page(
    'This code has expired',
    'Pairing codes work once and expire after 5 minutes. On the computer running t3 mini, open Settings → Devices and get a new code.',
  )
// Opening a pairing link shows this; only pressing the button pairs (see the note at the top).
// The code is checked against pairingCodeFormat before it gets here, so it's safe in the HTML.
const connectPage = (code: string) =>
  page(
    'Connect this device?',
    'This device will be able to use t3 mini, and run agents on the computer that runs it, for 30 days. Only continue on your own device.',
    `<form method="post" action="/pair"><input type="hidden" name="code" value="${code}"><button type="submit" style="font:inherit;font-weight:600;padding:0.65rem 1.4rem;border:0;border-radius:0.6rem;background:#4f46e5;color:#fff;cursor:pointer">Connect this device</button></form>`,
  )
// A small form body (the pairing code), refused past a limit.
function readForm(request: http.IncomingMessage, limit = 2048) {
  return new Promise<URLSearchParams | null>((resolve) => {
    let body = ''
    let tooBig = false
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      if (tooBig) return
      body += chunk
      if (body.length > limit) tooBig = true
    })
    request.on('end', () => resolve(tooBig ? null : new URLSearchParams(body)))
    request.on('error', () => resolve(null))
  })
}

export class RemoteAccess {
  devices = new Map<string, Device>()
  private codes = new Map<string, number>()
  private server?: http.Server
  private upstreamPort = 0
  private sockets = new Map<string, Set<net.Socket>>()
  private lastSaved = 0
  private mode: PhoneMode = 'lan'
  // Tailscale mode: the Host phones use, e.g. "macbook.tail1234.ts.net:8443".
  private tailscaleHost?: string
  private exitHooked = false
  private saved: Saved = { autoResume: true, wasOn: false }
  private resuming?: { cancelled: boolean }
  private resumeProblem?: string
  // Removing a serve entry a crash left behind, which must finish before serving again.
  private staleServe: Promise<void> = Promise.resolve()
  // Turning on and off happens one at a time, so a reconnect can't race your own switch.
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly path: string,
    private options: {
      port?: number
      addresses?: () => string[]
      tailscale?: TailscaleControl
    } = {},
  ) {}
  private get tailscale() {
    return this.options.tailscale ?? tailscale
  }
  private get cookieName() {
    return this.mode === 'tailscale' ? httpsCookie : lanCookie
  }
  get port() {
    return this.options.port ?? (Number(process.env.T3_MINI_PHONE_PORT) || 4311)
  }
  private addresses() {
    return (this.options.addresses ?? lanAddresses)()
  }
  get enabled() {
    return Boolean(this.server?.listening)
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as Device[]
      const now = new Date().toISOString()
      for (const device of saved)
        if (typeof device?.tokenHash === 'string' && device.expiresAt > now)
          this.devices.set(device.id, device)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    try {
      const saved = JSON.parse(await readFile(this.settingsPath, 'utf8')) as Partial<Saved>
      if (typeof saved.autoResume === 'boolean') this.saved.autoResume = saved.autoResume
      if (typeof saved.wasOn === 'boolean') this.saved.wasOn = saved.wasOn
    } catch {
      // Missing or unreadable: the defaults.
    }
    // Off on restart: a serve entry left behind by a crash is removed (only if it's ours).
    this.staleServe = this.tailscale.stopServe(this.port).catch(() => {})
  }
  private get settingsPath() {
    return join(dirname(this.path), 'phone-access.json')
  }
  private async saveSettings(change: Partial<Saved>) {
    this.saved = { ...this.saved, ...change }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(this.settingsPath + '.tmp', JSON.stringify(this.saved), { mode: 0o600 })
    await rename(this.settingsPath + '.tmp', this.settingsPath)
  }
  private serial<T>(task: () => Promise<T>) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }
  private stopResuming() {
    if (this.resuming) this.resuming.cancelled = true
    this.resuming = undefined
    this.resumeProblem = undefined
  }
  // The Allow phones switch: turns phone access on or off and remembers it for restarts.
  async set(enabled: boolean, upstreamPort: number, mode: PhoneMode = 'lan') {
    this.stopResuming()
    await this.serial(async () => {
      if (enabled) await this.enable(upstreamPort, mode)
      else await this.disable()
      await this.saveSettings({ wasOn: enabled && mode === 'tailscale' })
    })
  }
  async setAutoResume(autoResume: boolean) {
    if (!autoResume) this.stopResuming()
    await this.saveSettings({ autoResume })
  }
  // At startup: turns Tailscale access back on if it was on, so paired phones reconnect.
  // Tailscale may still be starting (the Mac just booted or woke), so it tries for a while.
  resume(upstreamPort: number, delays = resumeDelays) {
    if (this.enabled || this.resuming || !this.saved.autoResume || !this.saved.wasOn) return
    const attempt = { cancelled: false }
    this.resuming = attempt
    void (async () => {
      await this.staleServe
      for (const wait of delays) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
        try {
          const done = await this.serial(async () => {
            if (attempt.cancelled || this.enabled) return true
            await this.enable(upstreamPort, 'tailscale')
            return true
          })
          if (done) break
        } catch (error) {
          if (!attempt.cancelled)
            this.resumeProblem = error instanceof Error ? error.message : 'Could not reconnect.'
        }
      }
      if (this.resuming === attempt) {
        this.resuming = undefined
        if (this.enabled) this.resumeProblem = undefined
      }
    })()
  }
  private async save() {
    this.lastSaved = Date.now()
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(this.path + '.tmp', JSON.stringify([...this.devices.values()]), { mode: 0o600 })
    await rename(this.path + '.tmp', this.path)
  }

  status(): RemoteStatus {
    const tailnet = this.mode === 'tailscale' && this.tailscaleHost
    return {
      enabled: this.enabled,
      mode: this.mode,
      port: this.port,
      addresses: !this.enabled ? [] : tailnet ? [this.tailscaleHost!] : this.addresses(),
      ...(this.enabled && tailnet ? { url: `https://${this.tailscaleHost}` } : {}),
      devices: [...this.devices.values()]
        .map(({ tokenHash: _hash, ...device }) => device)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
      autoResume: this.saved.autoResume,
      resuming: Boolean(this.resuming),
      ...(this.resumeProblem && !this.enabled ? { resumeProblem: this.resumeProblem } : {}),
    }
  }
  // A one-time code for the QR link; only the Mac (a local request) may create one.
  createPairing() {
    if (!this.enabled) throw new Error('Turn on Allow other devices first.')
    const now = Date.now()
    for (const [hash, expires] of this.codes) if (expires < now) this.codes.delete(hash)
    const code = token(18)
    const expiresAt = now + pairingMs
    this.codes.set(sha256(code), expiresAt)
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      urls:
        this.mode === 'tailscale' && this.tailscaleHost
          ? [`https://${this.tailscaleHost}/pair?code=${encodeURIComponent(code)}`]
          : this.addresses().map(
              (address) => `http://${address}:${this.port}/pair?code=${encodeURIComponent(code)}`,
            ),
    }
  }
  // Whether a pairing code is still good, without using it.
  private pairable(code: string) {
    const expires = this.codes.get(sha256(code))
    return Boolean(expires && expires >= Date.now())
  }
  // Trades a pairing code for a session token. Codes work once and expire.
  async redeem(code: string, userAgent?: string) {
    const hash = sha256(code)
    const expires = this.codes.get(hash)
    this.codes.delete(hash)
    if (!expires || expires < Date.now()) return null
    const session = token(32)
    const now = new Date()
    const device: Device = {
      id: crypto.randomUUID(),
      name: deviceName(userAgent),
      tokenHash: sha256(session),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + sessionDays * 86_400_000).toISOString(),
    }
    this.devices.set(device.id, device)
    await this.save()
    return { token: session, device }
  }
  authenticate(cookieHeader: string | undefined) {
    const session = cookies(cookieHeader)[this.cookieName]
    if (!session) return null
    const hash = sha256(session)
    const device = [...this.devices.values()].find((item) => item.tokenHash === hash)
    if (!device) return null
    const now = new Date()
    if (device.expiresAt <= now.toISOString()) {
      void this.revoke(device.id)
      return null
    }
    device.lastSeenAt = now.toISOString()
    // Persist "last seen" at most once a minute.
    if (Date.now() - this.lastSaved > 60_000) void this.save().catch(() => {})
    return device
  }
  // Revokes one device, or all of them, and drops their open connections immediately.
  async revoke(id?: string) {
    const ids = id ? [id] : [...this.devices.keys()]
    for (const item of ids) {
      this.devices.delete(item)
      for (const socket of this.sockets.get(item) ?? []) socket.destroy()
      this.sockets.delete(item)
    }
    await this.save()
  }

  // Starts the gateway: on the LAN, or (Tailscale) on loopback behind `tailscale serve`.
  // Switching modes restarts it, which drops open connections.
  async enable(upstreamPort: number, mode: PhoneMode = 'lan') {
    this.upstreamPort = upstreamPort
    if (this.enabled && this.mode === mode) return
    if (this.enabled) await this.disable()
    let host: string | undefined
    if (mode === 'tailscale') {
      const status = await this.tailscale.status()
      if (!status.running || !status.dnsName)
        throw new Error(status.problem ?? 'Tailscale is not connected.')
      const port = this.tailscale.port()
      host = port === 443 ? status.dnsName : `${status.dnsName}:${port}`
    }
    const server = http.createServer((request, response) => void this.handle(request, response))
    server.on('upgrade', (request, socket, head) =>
      this.upgrade(request, socket as net.Socket, head),
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // Tailscale's serve connects from this Mac, so the gateway needn't face the network.
      server.listen(this.port, mode === 'tailscale' ? '127.0.0.1' : '0.0.0.0', () => resolve())
    })
    if (mode === 'tailscale') {
      try {
        await this.tailscale.serve(this.port)
      } catch (error) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        throw error
      }
      // Never let the tailnet address outlive t3 mini (it's served again on restart, if
      // reconnecting is on).
      if (!this.exitHooked) {
        this.exitHooked = true
        process.once('exit', () => {
          if (this.mode === 'tailscale' && this.enabled) this.tailscale.stopServeNow()
        })
      }
    }
    this.mode = mode
    this.tailscaleHost = host
    this.server = server
  }
  async disable() {
    const server = this.server
    const wasTailscale = this.mode === 'tailscale' && Boolean(server)
    this.server = undefined
    this.codes.clear()
    if (wasTailscale) await this.tailscale.stopServe(this.port).catch(() => {})
    for (const sockets of this.sockets.values()) for (const socket of sockets) socket.destroy()
    this.sockets.clear()
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // Shared checks for HTTP and WebSocket requests: the address you used must be one of this
  // Mac's LAN addresses, the request must come from a private network, and any Origin must be
  // this gateway itself (no other site can drive it). Over Tailscale: the tailnet name, from
  // `tailscale serve` on this Mac, with an https origin.
  private allowed(request: http.IncomingMessage) {
    const origin = request.headers.origin
    if (this.mode === 'tailscale') {
      const host = this.tailscaleHost
      return (
        Boolean(host) &&
        request.headers.host === host &&
        isLoopback(request.socket.remoteAddress) &&
        (!origin || origin === `https://${host}`)
      )
    }
    const hosts = this.addresses().map((address) => `${address}:${this.port}`)
    const host = request.headers.host ?? ''
    if (!hosts.includes(host) || !isPrivateAddress(request.socket.remoteAddress)) return false
    return !origin || origin === `http://${host}`
  }
  private track(device: Device, socket: net.Socket) {
    const sockets = this.sockets.get(device.id) ?? new Set()
    sockets.add(socket)
    this.sockets.set(device.id, sockets)
    socket.once('close', () => sockets.delete(socket))
  }
  // Headers for the app: who's calling is the gateway (local), marked remote; nothing the
  // client sent can claim otherwise, and the session cookie stays here.
  private forwardHeaders(request: http.IncomingMessage) {
    const headers: http.OutgoingHttpHeaders = {}
    // Tailscale's identity headers aren't used: being on the tailnet isn't authentication here.
    for (const [key, value] of Object.entries(request.headers))
      if (!key.startsWith('x-t3-') && !key.startsWith('tailscale-') && key !== 'referer')
        headers[key] = value
    const local = `127.0.0.1:${this.upstreamPort}`
    headers.host = local
    if (request.headers.origin) headers.origin = `http://${local}`
    const rest = (request.headers.cookie ?? '')
      .split(';')
      .filter(
        (part) =>
          part.trim() &&
          !part.trim().startsWith(`${lanCookie}=`) &&
          !part.trim().startsWith(`${httpsCookie}=`),
      )
      .join(';')
    if (rest) headers.cookie = rest
    else delete headers.cookie
    headers[remoteHeader] = '1'
    return headers
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!this.allowed(request)) {
      response
        .writeHead(403, pageHeaders)
        .end(page('Forbidden', 'This address or page can’t be used to reach t3 mini.'))
      return
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (url.pathname === '/pair') {
      // Opening the link: show the button. Checking the code doesn't use it, so a link preview
      // or a browser preloading the address can't burn it.
      if (request.method === 'GET' || request.method === 'HEAD') {
        const code = url.searchParams.get('code') ?? ''
        const ok = pairingCodeFormat.test(code) && this.pairable(code)
        response.writeHead(ok ? 200 : 401, pageHeaders).end(ok ? connectPage(code) : expiredPage())
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'GET, POST' }).end()
        return
      }
      // Pressing the button. allowed() already refused any other site's origin.
      if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
        response.writeHead(415).end()
        return
      }
      const form = await readForm(request)
      if (!form) {
        response.writeHead(413).end()
        return
      }
      const result = await this.redeem(form.get('code') ?? '', request.headers['user-agent'])
      if (!result) {
        response.writeHead(401, pageHeaders).end(expiredPage())
        return
      }
      response
        .writeHead(303, {
          Location: '/',
          'Set-Cookie': `${this.cookieName}=${result.token}; HttpOnly;${this.mode === 'tailscale' ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${sessionDays * 86_400}`,
          'Cache-Control': 'no-store',
        })
        .end()
      return
    }
    const device = this.authenticate(request.headers.cookie)
    if (!device) {
      response
        .writeHead(401, pageHeaders)
        .end(
          page(
            'Not connected',
            'On the computer running t3 mini, open Settings → Devices, then scan the QR code with this device or open the copied link here.',
          ),
        )
      return
    }
    this.track(device, request.socket)
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: this.upstreamPort,
        method: request.method,
        path: request.url,
        headers: this.forwardHeaders(request),
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(response)
      },
    )
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' })
      response.end('t3 mini is not reachable.')
    })
    request.pipe(upstream)
  }

  // WebSockets (the dev server's live reload) go through the same checks, then are piped.
  private upgrade(request: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    const device = this.allowed(request) ? this.authenticate(request.headers.cookie) : null
    if (!device) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = net.connect(this.upstreamPort, '127.0.0.1', () => {
      const headers = this.forwardHeaders(request)
      const lines = Object.entries(headers).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}`),
      )
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    this.track(device, socket)
    this.track(device, upstream)
  }
}

// One instance per server process (kept across dev reloads). It starts switched off; resume()
// turns Tailscale access back on at startup if it was on.
const globals = globalThis as typeof globalThis & { t3MiniRemote?: Promise<RemoteAccess> }
export function getRemoteAccess(path: string) {
  return (globals.t3MiniRemote ??= (async () => {
    const access = new RemoteAccess(path)
    await access.load()
    return access
  })())
}
