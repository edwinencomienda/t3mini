import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteAccess, isPrivateAddress } from './remote'

let directory: string
let upstream: http.Server
let upstreamPort: number
let access: RemoteAccess
let port: number
let seen: http.IncomingHttpHeaders

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
// Raw requests so the Host header can be set (fetch always derives it from the URL).
function request(path: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const outgoing = http.request(
        { host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
        (response) => {
          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          )
        },
      )
      outgoing.on('error', reject)
      outgoing.end()
    },
  )
}
async function pair() {
  const { code } = access.createPairing()
  const response = await request(`/pair?code=${encodeURIComponent(code)}`, {
    'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1',
  })
  const cookie = String(response.headers['set-cookie']?.[0] ?? '').split(';')[0]!
  return { code, response, cookie }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-remote-'))
  upstream = http.createServer((incoming, response) => {
    seen = incoming.headers
    response.end('ok from app')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as { port: number }).port
  port = await freePort()
  access = new RemoteAccess(join(directory, 'devices.json'), {
    port,
    addresses: () => ['127.0.0.1'],
  })
})
afterEach(async () => {
  vi.useRealTimers()
  await access.disable()
  await new Promise((resolve) => upstream.close(resolve))
  await rm(directory, { recursive: true, force: true })
})

it('is off until enabled, and only pairs while on', async () => {
  expect(access.enabled).toBe(false)
  expect(() => access.createPairing()).toThrow('Turn on')
  await expect(request('/')).rejects.toThrow()
  await access.enable(upstreamPort)
  expect(access.status()).toMatchObject({ enabled: true, port, addresses: ['127.0.0.1'] })
})
it('rejects unpaired devices, other hostnames, and other sites', async () => {
  await access.enable(upstreamPort)
  expect((await request('/')).status).toBe(401)
  expect((await request('/', { host: `localhost:${port}` })).status).toBe(403)
  const { cookie } = await pair()
  expect((await request('/', { cookie, origin: 'http://evil.example' })).status).toBe(403)
  expect((await request('/', { cookie, origin: `http://127.0.0.1:${port}` })).status).toBe(200)
})
it('pairs with a one-time code and forwards requests marked as remote', async () => {
  await access.enable(upstreamPort)
  const { code, response, cookie } = await pair()
  expect(response.status).toBe(302)
  expect(String(response.headers['set-cookie'])).toMatch(
    /HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000/,
  )
  // The same code can't be used twice.
  expect((await request(`/pair?code=${encodeURIComponent(code)}`)).status).toBe(401)
  const forwarded = await request('/api/bootstrap', {
    cookie: `${cookie}; theme=dark`,
    'x-t3-remote': '0',
    origin: `http://127.0.0.1:${port}`,
  })
  expect(forwarded).toMatchObject({ status: 200, body: 'ok from app' })
  // The phone can't claim to be local, its session cookie stays at the gateway, and the app
  // sees a same-origin local request.
  expect(seen['x-t3-remote']).toBe('1')
  expect(seen.host).toBe(`127.0.0.1:${upstreamPort}`)
  expect(seen.origin).toBe(`http://127.0.0.1:${upstreamPort}`)
  expect(seen.cookie).toBe('theme=dark')
  expect(access.status().devices).toEqual([expect.objectContaining({ name: 'iPhone · Safari' })])
})
it('expires pairing codes after five minutes', async () => {
  await access.enable(upstreamPort)
  vi.useFakeTimers({ toFake: ['Date'] })
  const { code } = access.createPairing()
  vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
  expect((await request(`/pair?code=${encodeURIComponent(code)}`)).status).toBe(401)
})
it('stores only token hashes, drops expired devices, and revokes access immediately', async () => {
  await access.enable(upstreamPort)
  const { cookie } = await pair()
  const token = cookie.split('=')[1]!
  expect(await readFile(join(directory, 'devices.json'), 'utf8')).not.toContain(token)
  const [device] = access.status().devices
  await access.revoke(device!.id)
  expect((await request('/', { cookie })).status).toBe(401)

  await writeFile(
    join(directory, 'devices.json'),
    JSON.stringify([
      {
        id: 'old',
        name: 'Old',
        tokenHash: 'x',
        createdAt: '',
        lastSeenAt: '',
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    ]),
  )
  const reloaded = new RemoteAccess(join(directory, 'devices.json'))
  await reloaded.load()
  expect(reloaded.status().devices).toEqual([])
})
it('closes the port when switched off', async () => {
  await access.enable(upstreamPort)
  const { cookie } = await pair()
  await access.disable()
  await expect(request('/', { cookie })).rejects.toThrow()
})
it('accepts only private network addresses', () => {
  for (const ip of ['192.168.1.5', '10.0.0.2', '172.20.1.1', '::ffff:192.168.0.9', '127.0.0.1'])
    expect(isPrivateAddress(ip)).toBe(true)
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', undefined])
    expect(isPrivateAddress(ip)).toBe(false)
})
