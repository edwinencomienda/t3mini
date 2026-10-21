import http from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Machines, parsePairingLink } from './machines'

// A stand-in for another machine's gateway (remote.ts, local-network mode): POST /pair trades a
// code for a session cookie; everything else needs that cookie.
let gateway: http.Server
let origin: string
let seen: http.IncomingHttpHeaders
let machines: Machines
let directory: string
const code = 'abc123'

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3m-machines-'))
  gateway = http.createServer((request, response) => {
    seen = request.headers
    if (request.url === '/pair' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        if (new URLSearchParams(body).get('code') !== code) return response.writeHead(401).end()
        response.writeHead(303, {
          Location: '/',
          'Set-Cookie': 't3m_session=secret-token; HttpOnly',
        })
        response.end()
      })
      return
    }
    if (request.headers.cookie !== 't3m_session=secret-token') return response.writeHead(401).end()
    if (request.url === '/go') {
      response.writeHead(302, { Location: `${origin}/api/bootstrap`, 'Set-Cookie': 'x=1' }).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ path: request.url, threads: [] }))
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`
  machines = new Machines(
    join(directory, 'machines.json'),
    30_000 + Math.floor(Math.random() * 20_000),
  )
})
afterEach(async () => {
  await machines.close()
  await new Promise((resolve) => gateway.close(resolve))
  await rm(directory, { recursive: true, force: true })
})
const local = (port: number, path: string, headers: http.OutgoingHttpHeaders = {}) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
          (response) => {
            let body = ''
            response.on('data', (chunk) => (body += chunk))
            response.on('end', () =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
            )
          },
        )
        .on('error', reject)
    },
  )

it('pairs from a link, keeps the session server-side, and serves the machine locally', async () => {
  const added = await machines.add({ link: `${origin}/pair?code=${code}`, name: 'VPS' })
  // The session is saved owner-only and never listed.
  const saved = await readFile(join(directory, 'machines.json'), 'utf8')
  expect(saved).toContain('secret-token')
  expect((await stat(join(directory, 'machines.json'))).mode & 0o777).toBe(0o600)
  const [listed] = await machines.list()
  expect(listed).toMatchObject({ id: added.id, name: 'VPS', status: 'online' })
  expect(JSON.stringify(listed)).not.toContain('secret-token')
  // The local address forwards with the session, as the gateway's own host and origin, without
  // the browser's cookies or t3 mini's headers.
  const port = added.localPort
  const reply = await local(port, '/api/bootstrap', {
    cookie: 'theme=dark',
    origin: `http://127.0.0.1:${port}`,
    'x-t3-remote': '1',
  })
  expect(reply.status).toBe(200)
  expect(JSON.parse(reply.body)).toMatchObject({ path: '/api/bootstrap' })
  expect(seen.cookie).toBe('t3m_session=secret-token')
  expect(seen.host).toBe(new URL(origin).host)
  expect(seen.origin).toBe(origin)
  expect(seen['x-t3-remote']).toBeUndefined()
  expect(seen['user-agent']).toMatch(/^t3mini\//)
  // Redirects come back to the local address, and the machine's cookies never reach the browser.
  const redirect = await local(port, '/go')
  expect(redirect.headers.location).toBe('/api/bootstrap')
  expect(redirect.headers['set-cookie']).toBeUndefined()
  // Other sites and host names can't use it.
  expect((await local(port, '/api/bootstrap', { origin: 'http://evil.example' })).status).toBe(403)
  expect((await local(port, '/api/bootstrap', { host: `evil.example:${port}` })).status).toBe(403)
  // Removing it closes the address.
  await machines.remove(added.id)
  await expect(local(port, '/api/bootstrap')).rejects.toThrow()
  expect(await machines.list()).toEqual([])
})

it('refuses used codes, odd links, and public plain-HTTP addresses', async () => {
  await expect(machines.add({ link: `${origin}/pair?code=wrong` })).rejects.toThrow(/expired/)
  expect(() => parsePairingLink('hello')).toThrow(/isn’t a link/)
  expect(() => parsePairingLink('https://vps.example.ts.net:8443/')).toThrow(/pairing link/)
  expect(() => parsePairingLink('http://203.0.113.5:4311/pair?code=x')).toThrow(/Tailscale/)
  expect(parsePairingLink('https://vps.tail1.ts.net:8443/pair?code=x')).toEqual({
    origin: 'https://vps.tail1.ts.net:8443',
    code: 'x',
  })
})
