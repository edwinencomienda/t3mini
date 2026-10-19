import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteAccess, isPrivateAddress, type TailscaleControl } from './remote'
import type { TailscaleStatus } from './tailscale'

let directory: string
let upstream: http.Server
let upstreamPort: number
let access: RemoteAccess
let port: number
let seen: http.IncomingHttpHeaders
// A stand-in for the Tailscale CLI: what it reports, and which serve calls it got.
let tailnet: TailscaleStatus
let served: string[]
let serveFails: string | undefined
const fakeTailscale: TailscaleControl = {
  status: async () => tailnet,
  serve: async (gateway) => {
    if (serveFails) throw new Error(serveFails)
    served.push(`serve ${gateway}`)
  },
  stopServe: async (gateway) => {
    served.push(`stop ${gateway}`)
  },
  stopServeNow: () => {
    served.push('stop now')
  },
  port: () => 8443,
}
const tailnetHost = 'mac.tail1234.ts.net:8443'

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
  tailnet = { available: true, running: true, dnsName: 'mac.tail1234.ts.net' }
  served = []
  serveFails = undefined
  access = new RemoteAccess(join(directory, 'devices.json'), {
    port,
    addresses: () => ['127.0.0.1'],
    tailscale: fakeTailscale,
  })
})
afterEach(async () => {
  vi.useRealTimers()
  await access.disable()
  await new Promise((resolve) => upstream.close(resolve))
  // A background "last seen" save may still be writing; retry instead of failing on it.
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
  expect(access.enabled).toBe(false)
  // Nothing answers for the gateway any more. (Checked by what answers, not by the connection
  // failing: in the parallel suite another test may start its own server on the freed port.)
  const after = await request('/', { cookie }).catch(() => null)
  expect(after?.body).not.toBe('ok from app')
})
it('accepts only private network addresses', () => {
  for (const ip of ['192.168.1.5', '10.0.0.2', '172.20.1.1', '::ffff:192.168.0.9', '127.0.0.1'])
    expect(isPrivateAddress(ip)).toBe(true)
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', undefined])
    expect(isPrivateAddress(ip)).toBe(false)
})

describe('over Tailscale (HTTPS)', () => {
  const pairOverTailnet = async () => {
    const { code } = access.createPairing()
    const response = await request(`/pair?code=${encodeURIComponent(code)}`, {
      host: tailnetHost,
      'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1',
    })
    return { response, cookie: String(response.headers['set-cookie']?.[0] ?? '').split(';')[0]! }
  }

  it('serves the gateway on the tailnet name and pairs with an HTTPS link', async () => {
    await access.enable(upstreamPort, 'tailscale')
    expect(served).toEqual([`serve ${port}`])
    expect(access.status()).toMatchObject({
      enabled: true,
      mode: 'tailscale',
      url: `https://${tailnetHost}`,
      addresses: [tailnetHost],
    })
    expect(access.createPairing().urls).toEqual([
      expect.stringMatching(/^https:\/\/mac\.tail1234\.ts\.net:8443\/pair\?code=/),
    ])
    const { response, cookie } = await pairOverTailnet()
    expect(response.status).toBe(302)
    // A Secure, host-only session cookie, separate from the plain-HTTP one.
    expect(String(response.headers['set-cookie'])).toMatch(
      /^__Host-t3m_session=[\w-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/,
    )
    const forwarded = await request('/api/bootstrap', {
      host: tailnetHost,
      cookie,
      origin: `https://${tailnetHost}`,
      'tailscale-user-login': 'someone@example.com',
    })
    expect(forwarded).toMatchObject({ status: 200, body: 'ok from app' })
    expect(seen['x-t3-remote']).toBe('1')
    expect(seen.cookie).toBeUndefined()
    // Being on the tailnet isn't authentication: Tailscale's identity headers aren't passed on.
    expect(seen['tailscale-user-login']).toBeUndefined()
  })

  it('refuses LAN addresses, http origins, and plain-HTTP cookies in this mode', async () => {
    await access.enable(upstreamPort, 'tailscale')
    const { cookie } = await pairOverTailnet()
    expect((await request('/api/bootstrap', { cookie })).status).toBe(403)
    expect(
      (
        await request('/api/bootstrap', {
          host: tailnetHost,
          cookie,
          origin: `http://${tailnetHost}`,
        })
      ).status,
    ).toBe(403)
    const lanCookie = cookie.replace('__Host-t3m_session', 't3m_session')
    expect((await request('/api/bootstrap', { host: tailnetHost, cookie: lanCookie })).status).toBe(
      401,
    )
  })

  it('only starts when Tailscale is connected, and cleans up on failure and when switched off', async () => {
    tailnet = { available: true, running: false, problem: 'Tailscale is not connected.' }
    await expect(access.enable(upstreamPort, 'tailscale')).rejects.toThrow('not connected')
    expect(access.enabled).toBe(false)
    tailnet = { available: true, running: true, dnsName: 'mac.tail1234.ts.net' }
    serveFails = 'Turn on HTTPS (Serve) for your tailnet first'
    await expect(access.enable(upstreamPort, 'tailscale')).rejects.toThrow('Turn on HTTPS')
    expect(access.enabled).toBe(false)
    serveFails = undefined
    await access.enable(upstreamPort, 'tailscale')
    await access.disable()
    expect(served).toEqual([`serve ${port}`, `stop ${port}`])
    expect(access.enabled).toBe(false)
  })

  describe('after a restart', () => {
    // A new process: same saved files, a fresh (off) gateway.
    const restart = async () => {
      await access.disable()
      access = new RemoteAccess(join(directory, 'devices.json'), {
        port,
        addresses: () => ['127.0.0.1'],
        tailscale: fakeTailscale,
      })
      await access.load()
    }
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
    }

    it('turns Tailscale access back on, so paired phones reconnect', async () => {
      await access.load()
      await access.set(true, upstreamPort, 'tailscale')
      const { cookie } = await pairOverTailnet()
      await restart()
      expect(access.enabled).toBe(false)
      access.resume(upstreamPort, [0])
      await until(() => access.enabled)
      expect(access.status()).toMatchObject({ enabled: true, mode: 'tailscale', autoResume: true })
      // The stale serve entry is removed before serving again.
      expect(served.slice(-2)).toEqual([`stop ${port}`, `serve ${port}`])
      const forwarded = await request('/api/bootstrap', { host: tailnetHost, cookie })
      expect(forwarded).toMatchObject({ status: 200, body: 'ok from app' })
    })

    it('keeps trying while Tailscale starts up, and says why', async () => {
      await access.load()
      await access.set(true, upstreamPort, 'tailscale')
      await restart()
      tailnet = { available: true, running: false, problem: 'Tailscale is not connected.' }
      access.resume(upstreamPort, [0, 60])
      await until(() => Boolean(access.status().resumeProblem))
      expect(access.status()).toMatchObject({
        resuming: true,
        resumeProblem: 'Tailscale is not connected.',
      })
      tailnet = { available: true, running: true, dnsName: 'mac.tail1234.ts.net' }
      await until(() => access.enabled)
      expect(access.status()).toMatchObject({ enabled: true, resuming: false })
      expect(access.status().resumeProblem).toBeUndefined()
    })

    it('stays off for local network access, when you switched it off, or with the setting off', async () => {
      await access.load()
      await access.set(true, upstreamPort, 'lan')
      await restart()
      access.resume(upstreamPort, [0])
      await new Promise((r) => setTimeout(r, 30))
      expect(access.status()).toMatchObject({ enabled: false, resuming: false })

      await access.set(true, upstreamPort, 'tailscale')
      await access.set(false, upstreamPort, 'tailscale')
      await restart()
      access.resume(upstreamPort, [0])
      await new Promise((r) => setTimeout(r, 30))
      expect(access.enabled).toBe(false)

      await access.set(true, upstreamPort, 'tailscale')
      await access.setAutoResume(false)
      await restart()
      expect(access.status().autoResume).toBe(false)
      access.resume(upstreamPort, [0])
      await new Promise((r) => setTimeout(r, 30))
      expect(access.enabled).toBe(false)
    })

    it('gives way when you switch phone access off while it is still trying', async () => {
      await access.load()
      await access.set(true, upstreamPort, 'tailscale')
      await restart()
      tailnet = { available: true, running: false, problem: 'Tailscale is not connected.' }
      access.resume(upstreamPort, [0, 40])
      await until(() => Boolean(access.status().resumeProblem))
      await access.set(false, upstreamPort, 'tailscale')
      tailnet = { available: true, running: true, dnsName: 'mac.tail1234.ts.net' }
      await new Promise((r) => setTimeout(r, 80))
      expect(access.status()).toMatchObject({ enabled: false, resuming: false })
    })
  })

  it('switches back to the local network on request', async () => {
    await access.enable(upstreamPort, 'tailscale')
    await access.enable(upstreamPort, 'lan')
    expect(access.status()).toMatchObject({ mode: 'lan', addresses: ['127.0.0.1'] })
    expect(access.status().url).toBeUndefined()
    expect(served).toContain(`stop ${port}`)
  })
})
