import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

// Previews: open a dev server that runs on this Mac (localhost:3000) on a paired phone or tablet.
// Each shared dev server gets its own address next to the phone-access gateway, at the root
// (apps assume they live at "/"): https://<tailnet name>:<port + 10000> over Tailscale, or
// http://<LAN address>:<port + 10000> on the local network. Only paired devices get in: the
// phone asks t3 mini for a one-time pass (POST /api/previews), opens the preview with it, and
// gets a cookie for that address.
//
// Requests are forwarded to localhost:<port> as if they came from localhost: Host and Origin say
// localhost (dev servers like Vite refuse other host names), redirects back to localhost are
// pointed at the preview address, and t3 mini's own cookies are never passed to the app (cookies
// don't care about ports, so the browser sends them here too). WebSockets (live reload) pass
// through the same way.

export type PreviewMode = 'lan' | 'tailscale'
// What the previews need from phone access (see RemoteAccess.previewHost).
export type PreviewHost = {
  mode: PreviewMode
  // Tailscale: this Mac's tailnet name, e.g. mac.tail1234.ts.net.
  dnsName?: string
  // Local network: this Mac's LAN addresses.
  addresses: () => string[]
  // Whether a paired device is still paired (revoked ones lose their previews too).
  deviceExists: (id: string) => boolean
  // Tailscale: publish http://127.0.0.1:<localPort> as https://<name>:<httpsPort>, and undo it.
  serve?: (localPort: number, httpsPort: number) => Promise<void>
  stopServe?: (httpsPort: number) => Promise<void>
}
export type PreviewInfo = { port: number; url: string }

const passMs = 2 * 60_000
const sessionMs = 12 * 60 * 60_000
const passPath = '/__t3-preview'
// t3 mini's own cookies: never forwarded to the app.
const ownCookie = /^(?:__Host-)?t3[mp]_/

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const token = (bytes: number) => randomBytes(bytes).toString('base64url')
const isLoopback = (address: string | undefined) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')
const isPrivate = (address: string | undefined) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(
    (address ?? '').replace(/^::ffff:/, ''),
  )
// The preview address for a dev server's port.
export const previewPort = (port: number) => port + 10_000
// A page on the preview to land on: a path starting with a single "/", without control
// characters or backslashes, so "//other.site" or "/\\other.site" can't send the phone elsewhere.
export function landingPath(path: string) {
  return /^\/(?![\/\\])[^\s\\\x00-\x1f]*$/.test(path) && path.length <= 2000 ? path : '/'
}

type Preview = {
  target: number
  publicPort: number
  server: http.Server
  // One-time passes: whose, until when, and the page to land on.
  passes: Map<string, { deviceId: string; expires: number; next: string }>
  sessions: Map<string, { deviceId: string; expires: number }>
  sockets: Set<net.Socket>
}

export class Previews {
  private previews = new Map<number, Preview>()
  constructor(private readonly host: () => PreviewHost | null) {}

  list(): PreviewInfo[] {
    const host = this.host()
    return host
      ? [...this.previews.values()].map((preview) => ({
          port: preview.target,
          url: this.origin(host, preview.publicPort),
        }))
      : []
  }
  private origin(host: PreviewHost, publicPort: number, address?: string) {
    return host.mode === 'tailscale'
      ? `https://${host.dnsName}:${publicPort}`
      : `http://${address ?? host.addresses()[0]}:${publicPort}`
  }
  private cookieName(host: PreviewHost, publicPort: number) {
    return host.mode === 'tailscale' ? `__Host-t3p_${publicPort}` : `t3p_${publicPort}`
  }

  // Opens (or reuses) the preview for a dev server's port and returns a link with a one-time
  // pass for this device. Local network: one link per LAN address the phone might be on.
  // landing: the page to land on (a localhost link tapped in the chat keeps its page); only a path
  // on this same preview, never another site.
  async open(target: number, deviceId: string, landing = '/') {
    const host = this.host()
    if (!host) throw new Error('Turn on phone access first.')
    if (!Number.isInteger(target) || target < 1 || target > 55_535)
      throw new Error('That port can’t be previewed.')
    let preview = this.previews.get(target)
    if (!preview) preview = await this.start(host, target)
    const pass = token(24)
    preview.passes.set(sha256(pass), {
      deviceId,
      expires: Date.now() + passMs,
      next: landingPath(landing),
    })
    const path = `${passPath}?pass=${encodeURIComponent(pass)}`
    const addresses = host.mode === 'tailscale' ? [undefined] : host.addresses()
    return {
      port: target,
      urls: addresses.map((address) => `${this.origin(host, preview.publicPort, address)}${path}`),
    }
  }

  private async start(host: PreviewHost, target: number): Promise<Preview> {
    const publicPort = previewPort(target)
    const preview: Preview = {
      target,
      publicPort,
      server: http.createServer(),
      passes: new Map(),
      sessions: new Map(),
      sockets: new Set(),
    }
    preview.server.on('request', (request, response) => this.handle(preview, request, response))
    preview.server.on('upgrade', (request, socket, head) =>
      this.upgrade(preview, request, socket as net.Socket, head),
    )
    preview.server.on('connection', (socket) => {
      preview.sockets.add(socket)
      socket.once('close', () => preview.sockets.delete(socket))
    })
    // Tailscale: loopback only, behind `tailscale serve` (HTTPS on the tailnet). Local network:
    // the preview port on every interface, like the gateway.
    const listenPort = host.mode === 'tailscale' ? 0 : publicPort
    await new Promise<void>((resolve, reject) => {
      preview.server.once('error', reject)
      preview.server.listen(listenPort, host.mode === 'tailscale' ? '127.0.0.1' : '0.0.0.0', () =>
        resolve(),
      )
    })
    if (host.mode === 'tailscale') {
      const local = (preview.server.address() as net.AddressInfo).port
      try {
        await host.serve?.(local, publicPort)
      } catch (error) {
        await new Promise<void>((resolve) => preview.server.close(() => resolve()))
        throw error
      }
    }
    this.previews.set(target, preview)
    return preview
  }

  async close(target: number) {
    const preview = this.previews.get(target)
    if (!preview) return
    this.previews.delete(target)
    const host = this.host()
    if (host?.mode === 'tailscale') await host.stopServe?.(preview.publicPort).catch(() => {})
    for (const socket of preview.sockets) socket.destroy()
    preview.server.closeAllConnections()
    await new Promise<void>((resolve) => preview.server.close(() => resolve()))
  }
  async closeAll() {
    await Promise.all([...this.previews.keys()].map((target) => this.close(target)))
  }
  // Closes previews whose dev server is gone.
  async keepOnly(ports: number[]) {
    await Promise.all(
      [...this.previews.keys()]
        .filter((target) => !ports.includes(target))
        .map((target) => this.close(target)),
    )
  }
  // The HTTPS ports in use (to turn them off when t3 mini exits).
  publicPorts() {
    return [...this.previews.values()].map((preview) => preview.publicPort)
  }

  // The address the device used must be this preview's (blocks DNS rebinding), from where phone
  // access accepts devices, and any Origin must be the preview itself.
  private allowed(host: PreviewHost, preview: Preview, request: http.IncomingMessage) {
    const origin = request.headers.origin
    if (host.mode === 'tailscale') {
      const name = `${host.dnsName}:${preview.publicPort}`
      return (
        Boolean(host.dnsName) &&
        request.headers.host === name &&
        isLoopback(request.socket.remoteAddress) &&
        (!origin || origin === `https://${name}`)
      )
    }
    const names = host.addresses().map((address) => `${address}:${preview.publicPort}`)
    const name = request.headers.host ?? ''
    if (!names.includes(name) || !isPrivate(request.socket.remoteAddress)) return false
    return !origin || origin === `http://${name}`
  }
  private session(host: PreviewHost, preview: Preview, cookieHeader: string | undefined) {
    const value = cookieHeader
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${this.cookieName(host, preview.publicPort)}=`))
      ?.split('=')[1]
    if (!value) return null
    const hash = sha256(value)
    const session = preview.sessions.get(hash)
    if (!session || session.expires < Date.now() || !host.deviceExists(session.deviceId)) {
      preview.sessions.delete(hash)
      return null
    }
    return session
  }

  // Headers for the dev server: as if from localhost, without t3 mini's cookies or what the
  // phone and Tailscale added about themselves.
  private forwardHeaders(preview: Preview, request: http.IncomingMessage, origin: string) {
    const local = `http://localhost:${preview.target}`
    const headers: http.OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(request.headers))
      if (
        !key.startsWith('x-forwarded-') &&
        !key.startsWith('tailscale-') &&
        !key.startsWith('x-t3-')
      )
        headers[key] = value
    headers.host = `localhost:${preview.target}`
    if (request.headers.origin) headers.origin = local
    if (typeof request.headers.referer === 'string' && request.headers.referer.startsWith(origin))
      headers.referer = local + request.headers.referer.slice(origin.length)
    const cookie = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !ownCookie.test(part))
      .join('; ')
    if (cookie) headers.cookie = cookie
    else delete headers.cookie
    return headers
  }
  // Redirects back to localhost point at the preview; the app's cookies can't name localhost.
  private replyHeaders(preview: Preview, reply: http.IncomingMessage, origin: string) {
    const headers = { ...reply.headers }
    const location = headers.location
    if (location) {
      const match = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(.*)$/i.exec(location)
      if (match && Number(match[1]) === preview.target) headers.location = origin + match[2]
    }
    if (headers['set-cookie'])
      headers['set-cookie'] = headers['set-cookie'].map((cookie) =>
        cookie.replace(/;\s*Domain=(?:localhost|127\.0\.0\.1)\b/gi, ''),
      )
    return headers
  }

  private handle(preview: Preview, request: http.IncomingMessage, response: http.ServerResponse) {
    const host = this.host()
    if (!host || !this.allowed(host, preview, request)) {
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden.')
      return
    }
    const origin = `${host.mode === 'tailscale' ? 'https' : 'http'}://${request.headers.host}`
    const url = new URL(request.url ?? '/', origin)
    // The link from t3 mini: trade its one-time pass for this address's cookie.
    if (url.pathname === passPath) {
      const hash = sha256(url.searchParams.get('pass') ?? '')
      const pass = preview.passes.get(hash)
      preview.passes.delete(hash)
      if (!pass || pass.expires < Date.now() || !host.deviceExists(pass.deviceId)) {
        response
          .writeHead(401, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          .end('This link was already used or expired. Open the preview again from t3 mini.')
        return
      }
      const session = token(32)
      preview.sessions.set(sha256(session), {
        deviceId: pass.deviceId,
        expires: Date.now() + sessionMs,
      })
      response
        .writeHead(303, {
          Location: pass.next,
          'Set-Cookie': `${this.cookieName(host, preview.publicPort)}=${session}; HttpOnly;${host.mode === 'tailscale' ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${sessionMs / 1000}`,
          'Cache-Control': 'no-store',
        })
        .end()
      return
    }
    if (!this.session(host, preview, request.headers.cookie)) {
      response
        .writeHead(401, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end(
          'Open this preview from t3 mini on a paired device (the process list → Open on this device).',
        )
      return
    }
    const upstream = http.request(
      {
        host: 'localhost',
        port: preview.target,
        method: request.method,
        path: request.url,
        headers: this.forwardHeaders(preview, request, origin),
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, this.replyHeaders(preview, reply, origin))
        reply.pipe(response)
      },
    )
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' })
      response.end(`Nothing is answering on localhost:${preview.target}.`)
    })
    request.pipe(upstream)
  }

  // WebSockets (live reload): the same checks and rewriting, then piped both ways.
  private upgrade(
    preview: Preview,
    request: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ) {
    const host = this.host()
    if (
      !host ||
      !this.allowed(host, preview, request) ||
      !this.session(host, preview, request.headers.cookie)
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const origin = `${host.mode === 'tailscale' ? 'https' : 'http'}://${request.headers.host}`
    const upstream = net.connect({ host: 'localhost', port: preview.target }, () => {
      const headers = this.forwardHeaders(preview, request, origin)
      const lines = Object.entries(headers).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}`),
      )
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  }
}
