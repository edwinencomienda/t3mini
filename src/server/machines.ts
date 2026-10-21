import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { hostname } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isPrivateAddress } from './remote'

// Machines: other computers running t3 mini (a VPS, another Mac) that this one opens (see
// docs/machines.md). The other machine pairs this one like a phone: `t3mini pair` there prints
// its gateway's one-time link, and this server trades it for that gateway's session, which it
// keeps here (machines.json, 0600) and never sends to a browser. Each machine then gets a local
// address, http://127.0.0.1:<port>, that shows its t3 mini: this server forwards every request
// to the machine's gateway with the session added. Loopback only, like the app.

export type Machine = {
  id: string
  name: string
  // The machine's gateway, e.g. https://vps.tail1234.ts.net:8443 or http://192.168.1.20:4311.
  origin: string
  // Its session (the gateway's cookie name and value). Secret: server-side only.
  cookie: string
  token: string
  addedAt: string
  // Where this Mac serves it (127.0.0.1).
  localPort: number
}
export type MachineSummary = Pick<Machine, 'id' | 'name' | 'origin' | 'addedAt'> & {
  url: string
  status: 'online' | 'offline' | 'unpaired'
  problem?: string
}

export class MachineError extends Error {
  name = 'MachineError'
}
export const isMachineError = (error: unknown): error is MachineError =>
  error instanceof Error && error.name === 'MachineError'

const sessionCookies = ['__Host-t3m_session', 't3m_session']
const agent = `t3mini/${process.env.npm_package_version ?? 'machine'} (${hostname()})`

// A pairing link from `t3mini pair` (or Settings → Devices on the other machine). HTTPS for any
// host (Tailscale), plain HTTP only for a private network address.
export function parsePairingLink(link: string) {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw new MachineError('That isn’t a link. Paste the whole link `t3mini pair` printed.')
  }
  const code = url.searchParams.get('code') ?? new URLSearchParams(url.hash.slice(1)).get('pair')
  if (url.pathname !== '/pair' || !code)
    throw new MachineError('That isn’t a t3 mini pairing link (it should end in /pair?code=…).')
  if (url.username || url.password) throw new MachineError('Links with a user name aren’t used.')
  if (url.protocol === 'http:' && !isPrivateAddress(url.hostname))
    throw new MachineError('Plain-HTTP links only work for local network addresses; use Tailscale.')
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new MachineError('Only http and https links are supported.')
  return { origin: url.origin, code }
}

// One request to a machine's gateway with its session; resolves with status, headers, body.
function call(
  machine: Pick<Machine, 'origin' | 'cookie' | 'token'> | { origin: string },
  path: string,
  init: {
    method?: string
    body?: string
    headers?: http.OutgoingHttpHeaders
    timeout?: number
  } = {},
) {
  const target = new URL(path, machine.origin)
  const client = target.protocol === 'https:' ? https : http
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const request = client.request(
        target,
        {
          method: init.method ?? 'GET',
          timeout: init.timeout ?? 8_000,
          headers: {
            'user-agent': agent,
            origin: machine.origin,
            ...('token' in machine ? { cookie: `${machine.cookie}=${machine.token}` } : {}),
            ...init.headers,
          },
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            if (body.length < 2_000_000) body += chunk
          })
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          )
        },
      )
      request.on('timeout', () => request.destroy(new Error('timed out')))
      request.on('error', reject)
      request.end(init.body)
    },
  )
}

// The local address that shows one machine: forwards to its gateway, adding the session.
class MachineProxy {
  private server: http.Server | null = null
  constructor(private machine: Machine) {}
  get port() {
    return this.machine.localPort
  }
  // Only this address, from this Mac: no other site or host name (DNS rebinding) gets in.
  private allowed(request: http.IncomingMessage) {
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
    const host = request.headers.host ?? ''
    const origin = request.headers.origin
    return (
      hosts.includes(host) &&
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') &&
      (!origin || origin === `http://${host}`)
    )
  }
  private headers(request: http.IncomingMessage) {
    const target = new URL(this.machine.origin)
    const headers: http.OutgoingHttpHeaders = {}
    // The browser's cookies and t3 mini's own headers never go to the other machine.
    for (const [key, value] of Object.entries(request.headers))
      if (
        !['host', 'origin', 'referer', 'cookie', 'connection'].includes(key) &&
        !key.startsWith('x-t3-') &&
        !key.startsWith('x-forwarded-') &&
        !key.startsWith('tailscale-')
      )
        headers[key] = value
    headers.host = target.host
    if (request.headers.origin) headers.origin = this.machine.origin
    headers.cookie = `${this.machine.cookie}=${this.machine.token}`
    headers['user-agent'] = agent
    return headers
  }
  async start() {
    if (this.server) return
    const server = http.createServer((request, response) => {
      if (!this.allowed(request)) {
        response.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden')
        return
      }
      const target = new URL(request.url ?? '/', this.machine.origin)
      const client = target.protocol === 'https:' ? https : http
      const upstream = client.request(
        target,
        { method: request.method, headers: this.headers(request) },
        (reply) => {
          const headers = { ...reply.headers }
          // The machine's session stays here; redirects to it come back to this address.
          delete headers['set-cookie']
          if (
            typeof headers.location === 'string' &&
            headers.location.startsWith(this.machine.origin)
          )
            headers.location = headers.location.slice(this.machine.origin.length) || '/'
          response.writeHead(reply.statusCode ?? 502, headers)
          reply.pipe(response)
        },
      )
      upstream.on('error', () => {
        if (!response.headersSent)
          response
            .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            .end(`Can’t reach ${this.machine.name} (${this.machine.origin}).`)
        else response.destroy()
      })
      response.on('close', () => upstream.destroy())
      request.pipe(upstream)
    })
    // WebSockets (live dictation) with the same rewriting.
    server.on('upgrade', (request, socket, head) => {
      if (!this.allowed(request)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      const target = new URL(request.url ?? '/', this.machine.origin)
      const client = target.protocol === 'https:' ? https : http
      const upstream = client.request(target, {
        method: request.method,
        headers: {
          ...this.headers(request),
          connection: 'Upgrade',
          upgrade: request.headers.upgrade,
        },
      })
      upstream.on('upgrade', (reply, remote, remoteHead) => {
        const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`]
        for (let index = 0; index < reply.rawHeaders.length; index += 2)
          if (reply.rawHeaders[index]!.toLowerCase() !== 'set-cookie')
            lines.push(`${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}`)
        socket.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (remoteHead.length) socket.write(remoteHead)
        if (head.length) remote.write(head)
        remote.pipe(socket).pipe(remote)
        remote.on('error', () => socket.destroy())
        socket.on('error', () => remote.destroy())
      })
      upstream.on('response', (reply) => {
        socket.end(
          `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\nConnection: close\r\n\r\n`,
        )
      })
      upstream.on('error', () => socket.destroy())
      upstream.end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
  }
  async stop() {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections?.()
    })
  }
}

// A free loopback port, from `start` up.
async function freePort(start: number, taken: Set<number>) {
  for (let port = start; port < start + 200; port++) {
    if (taken.has(port)) continue
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new MachineError('No free local port for this machine.')
}

export class Machines {
  private machines = new Map<string, Machine>()
  private proxies = new Map<string, MachineProxy>()
  private loaded: Promise<void> | null = null
  constructor(
    readonly path: string,
    // This t3 mini's port: machines get local addresses from 100 above it.
    private appPort = Number(process.env.PORT) || 4011,
  ) {}
  load() {
    return (this.loaded ??= (async () => {
      const saved: unknown = JSON.parse(await readFile(this.path, 'utf8').catch(() => '[]'))
      if (Array.isArray(saved))
        for (const machine of saved as Machine[])
          if (machine?.id && machine.origin && machine.token) this.machines.set(machine.id, machine)
      for (const machine of this.machines.values()) await this.serve(machine).catch(() => {})
    })())
  }
  private async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify([...this.machines.values()], null, 2), {
      mode: 0o600,
    })
    await rename(temporary, this.path)
  }
  // Opens the machine's local address (on a new port if its saved one was taken).
  private async serve(machine: Machine) {
    let proxy = new MachineProxy(machine)
    try {
      await proxy.start()
    } catch {
      machine.localPort = await freePort(this.appPort + 100, this.usedPorts(machine.id))
      await this.save()
      proxy = new MachineProxy(machine)
      await proxy.start()
    }
    this.proxies.set(machine.id, proxy)
  }
  private usedPorts(except?: string) {
    return new Set(
      [...this.machines.values()]
        .filter((item) => item.id !== except)
        .map((item) => item.localPort),
    )
  }
  // Pairs with another machine from its one-time link.
  async add(input: { link: string; name?: string }) {
    await this.load()
    const { origin, code } = parsePairingLink(input.link)
    if ([...this.machines.values()].some((machine) => machine.origin === origin))
      throw new MachineError('That machine is already added. Remove it first to pair again.')
    let reply
    try {
      reply = await call({ origin }, '/pair', {
        method: 'POST',
        body: new URLSearchParams({ code }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    } catch (error) {
      throw new MachineError(
        `Can’t reach ${origin} (${(error as Error).message}). Is t3mini running there, and is this Mac on the same tailnet or network?`,
      )
    }
    if (reply.status === 401)
      throw new MachineError('That link expired or was already used. Run `t3mini pair` again.')
    const set = ([] as string[]).concat(reply.headers['set-cookie'] ?? [])
    const session = set
      .map((value) => /^([^=;]+)=([^;]*)/.exec(value))
      .find((match) => match && sessionCookies.includes(match[1]!))
    if (reply.status !== 303 || !session)
      throw new MachineError(`Pairing failed (${reply.status}). Is that a t3 mini pairing link?`)
    const machine: Machine = {
      id: crypto.randomUUID(),
      name: input.name?.trim().slice(0, 60) || new URL(origin).hostname.split('.')[0]!,
      origin,
      cookie: session[1]!,
      token: session[2]!,
      addedAt: new Date().toISOString(),
      localPort: await freePort(this.appPort + 100, this.usedPorts()),
    }
    // The session works: its t3 mini answers.
    const check = await call(machine, '/api/bootstrap').catch(() => null)
    if (check?.status !== 200)
      throw new MachineError('Paired, but its t3 mini didn’t answer. Try again in a moment.')
    this.machines.set(machine.id, machine)
    await this.save()
    await this.serve(machine)
    return machine
  }
  async remove(id: string) {
    await this.load()
    const machine = this.machines.get(id)
    if (!machine) throw new MachineError('That machine isn’t added.')
    await this.proxies.get(id)?.stop()
    this.proxies.delete(id)
    this.machines.delete(id)
    await this.save()
  }
  async rename(id: string, name: string) {
    await this.load()
    const machine = this.machines.get(id)
    if (!machine) throw new MachineError('That machine isn’t added.')
    machine.name = name.trim().slice(0, 60) || machine.name
    await this.save()
    return machine
  }
  // Each machine with its local address and whether it answers right now.
  async list(): Promise<MachineSummary[]> {
    await this.load()
    return Promise.all(
      [...this.machines.values()].map(async (machine) => {
        const reply = await call(machine, '/api/bootstrap', { timeout: 3_000 }).catch(
          (error: Error) => ({ status: 0, body: error.message }),
        )
        const status: MachineSummary['status'] =
          reply.status === 200 ? 'online' : reply.status === 401 ? 'unpaired' : 'offline'
        return {
          id: machine.id,
          name: machine.name,
          origin: machine.origin,
          addedAt: machine.addedAt,
          url: `http://127.0.0.1:${machine.localPort}`,
          status,
          ...(status === 'unpaired'
            ? { problem: 'Its pairing expired or was revoked. Remove it and pair again.' }
            : status === 'offline'
              ? { problem: `Can’t reach ${machine.origin}.` }
              : {}),
        }
      }),
    )
  }
  async close() {
    await Promise.all([...this.proxies.values()].map((proxy) => proxy.stop()))
    this.proxies.clear()
  }
}

// One per process, kept across hot reloads (like the phone gateway).
const globals = globalThis as typeof globalThis & { t3MiniMachines?: Machines }
export function getMachines(path: string) {
  if (!globals.t3MiniMachines || globals.t3MiniMachines.path !== path)
    globals.t3MiniMachines = new Machines(path)
  void globals.t3MiniMachines.load()
  return globals.t3MiniMachines
}
