import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname } from 'node:path'

// Phone access over the local network. A gateway listens on the LAN only while switched on
// (never across restarts), lets in only paired devices, and forwards their requests to the
// loopback-only app, marked so the app knows they're remote.
//
// Pairing: the Mac shows a QR code with a one-time code (5 minutes). The phone trades it for a
// session cookie that lasts 30 days. Only hashes of codes and session tokens are kept.

export const sessionDays = 30
const pairingMs = 5 * 60_000
const cookieName = 't3m_session'
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
export type RemoteStatus = {
  enabled: boolean
  port: number
  addresses: string[]
  devices: DeviceInfo[]
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const token = (bytes: number) => randomBytes(bytes).toString('base64url')

// Private and link-local IPv4 ranges (plus loopback); the gateway refuses anything else.
export function isPrivateAddress(address: string | undefined) {
  const ip = (address ?? '').replace(/^::ffff:/, '')
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(ip)
}
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
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t3 mini</title><body style="font:15px -apple-system,system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.25rem;color:#27272a;text-align:center"><h1 style="font-size:20px">${title}</h1><p style="color:#71717a">${body}</p></body>`

export class RemoteAccess {
  devices = new Map<string, Device>()
  private codes = new Map<string, number>()
  private server?: http.Server
  private upstreamPort = 0
  private sockets = new Map<string, Set<net.Socket>>()
  private lastSaved = 0
  constructor(
    readonly path: string,
    private options: { port?: number; addresses?: () => string[] } = {},
  ) {}
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
  }
  private async save() {
    this.lastSaved = Date.now()
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(this.path + '.tmp', JSON.stringify([...this.devices.values()]), { mode: 0o600 })
    await rename(this.path + '.tmp', this.path)
  }

  status(): RemoteStatus {
    return {
      enabled: this.enabled,
      port: this.port,
      addresses: this.enabled ? this.addresses() : [],
      devices: [...this.devices.values()]
        .map(({ tokenHash: _hash, ...device }) => device)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    }
  }
  // A one-time code for the QR link; only the Mac (a local request) may create one.
  createPairing() {
    if (!this.enabled) throw new Error('Turn on phone access first.')
    const now = Date.now()
    for (const [hash, expires] of this.codes) if (expires < now) this.codes.delete(hash)
    const code = token(18)
    const expiresAt = now + pairingMs
    this.codes.set(sha256(code), expiresAt)
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      urls: this.addresses().map(
        (address) => `http://${address}:${this.port}/pair?code=${encodeURIComponent(code)}`,
      ),
    }
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
    const session = cookies(cookieHeader)[cookieName]
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

  async enable(upstreamPort: number) {
    this.upstreamPort = upstreamPort
    if (this.enabled) return
    const server = http.createServer((request, response) => void this.handle(request, response))
    server.on('upgrade', (request, socket, head) =>
      this.upgrade(request, socket as net.Socket, head),
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, '0.0.0.0', () => resolve())
    })
    this.server = server
  }
  async disable() {
    const server = this.server
    this.server = undefined
    this.codes.clear()
    for (const sockets of this.sockets.values()) for (const socket of sockets) socket.destroy()
    this.sockets.clear()
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // Shared checks for HTTP and WebSocket requests: the address you used must be one of this
  // Mac's LAN addresses, the request must come from a private network, and any Origin must be
  // this gateway itself (no other site can drive it).
  private allowed(request: http.IncomingMessage) {
    const hosts = this.addresses().map((address) => `${address}:${this.port}`)
    const host = request.headers.host ?? ''
    if (!hosts.includes(host) || !isPrivateAddress(request.socket.remoteAddress)) return false
    const origin = request.headers.origin
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
    for (const [key, value] of Object.entries(request.headers))
      if (!key.startsWith('x-t3-') && key !== 'referer') headers[key] = value
    const local = `127.0.0.1:${this.upstreamPort}`
    headers.host = local
    if (request.headers.origin) headers.origin = `http://${local}`
    const rest = (request.headers.cookie ?? '')
      .split(';')
      .filter((part) => part.trim() && !part.trim().startsWith(`${cookieName}=`))
      .join(';')
    if (rest) headers.cookie = rest
    else delete headers.cookie
    headers[remoteHeader] = '1'
    return headers
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!this.allowed(request)) {
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden')
      return
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (url.pathname === '/pair') {
      const result = await this.redeem(
        url.searchParams.get('code') ?? '',
        request.headers['user-agent'],
      )
      if (!result) {
        response
          .writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(
            page(
              'This code has expired',
              'Pairing codes work once and expire after 5 minutes. On your Mac, open Settings → Phone access and show a new QR code.',
            ),
          )
        return
      }
      response
        .writeHead(302, {
          Location: '/',
          'Set-Cookie': `${cookieName}=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionDays * 86_400}`,
          'Cache-Control': 'no-store',
        })
        .end()
      return
    }
    const device = this.authenticate(request.headers.cookie)
    if (!device) {
      response
        .writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(
          page(
            'Not connected',
            'On your Mac, open t3 mini → Settings → Phone access and scan the QR code with this device.',
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

// One instance per server process (kept across dev reloads). It starts switched off, so phone
// access is always off after a restart.
const globals = globalThis as typeof globalThis & { t3MiniRemote?: Promise<RemoteAccess> }
export function getRemoteAccess(path: string) {
  return (globals.t3MiniRemote ??= (async () => {
    const access = new RemoteAccess(path)
    await access.load()
    return access
  })())
}
