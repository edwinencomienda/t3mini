import http from 'node:http'
import net from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Previews, landingPath, previewPort, type PreviewHost } from './previews'

// A fake dev server on localhost, and previews on the "local network" (127.0.0.1 stands in for
// the Mac's LAN address).
let devServer: http.Server
let port: number
let seen: http.IncomingHttpHeaders
let paired: Set<string>
let previews: Previews

// A free port whose preview port (+10000) is free too.
async function freePorts() {
  for (;;) {
    const candidate = 20_000 + Math.floor(Math.random() * 30_000)
    const free = (p: number) =>
      new Promise<boolean>((resolve) => {
        const probe = net.createServer()
        probe.once('error', () => resolve(false))
        probe.listen(p, '127.0.0.1', () => probe.close(() => resolve(true)))
      })
    if ((await free(candidate)) && (await free(previewPort(candidate)))) return candidate
  }
}
// Raw requests, so the Host header can be set.
function request(path: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const outgoing = http.request(
        {
          host: '127.0.0.1',
          port: previewPort(port),
          path,
          headers: { host: `127.0.0.1:${previewPort(port)}`, ...headers },
        },
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
async function signIn() {
  const { urls } = await previews.open(port, 'phone-1')
  const pass = new URL(urls[0]!)
  const response = await request(`${pass.pathname}${pass.search}`)
  return {
    pass: `${pass.pathname}${pass.search}`,
    response,
    cookie: String(response.headers['set-cookie']).split(';')[0]!,
  }
}

beforeEach(async () => {
  port = await freePorts()
  devServer = http.createServer((incoming, response) => {
    seen = incoming.headers
    if (incoming.url === '/login')
      return response
        .writeHead(302, {
          Location: `http://localhost:${port}/dashboard`,
          'Set-Cookie': 'session=abc; Domain=localhost; Path=/; HttpOnly',
        })
        .end()
    response.end('hello from the app')
  })
  devServer.on('upgrade', (incoming, socket) => {
    seen = incoming.headers
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    )
  })
  await new Promise<void>((resolve) => devServer.listen(port, 'localhost', resolve))
  paired = new Set(['phone-1'])
  const host: PreviewHost = {
    mode: 'lan',
    addresses: () => ['127.0.0.1'],
    deviceExists: (id) => paired.has(id),
  }
  previews = new Previews(() => host)
})
afterEach(async () => {
  await previews.closeAll()
  await new Promise((resolve) => devServer.close(resolve))
})

it('lets in only paired devices, with a one-time pass that becomes a cookie', async () => {
  const { urls } = await previews.open(port, 'phone-1')
  expect(urls).toEqual([
    expect.stringMatching(
      new RegExp(`^http://127\\.0\\.0\\.1:${previewPort(port)}/__t3-preview\\?pass=`),
    ),
  ])
  expect((await request('/')).status).toBe(401)
  const { pass, response, cookie } = await signIn()
  expect(response.status).toBe(303)
  expect(response.headers.location).toBe('/')
  expect(String(response.headers['set-cookie'])).toMatch(
    new RegExp(`^t3p_${previewPort(port)}=[\\w-]+; HttpOnly; SameSite=Lax; Path=/;`),
  )
  // The pass works once.
  expect((await request(pass)).status).toBe(401)
  expect(await request('/', { cookie })).toMatchObject({ status: 200, body: 'hello from the app' })
  // A revoked device loses the preview too.
  paired.delete('phone-1')
  expect((await request('/', { cookie })).status).toBe(401)
})

it('talks to the dev server as localhost, keeps t3 mini’s cookies out, and fixes redirects', async () => {
  const { cookie } = await signIn()
  const origin = `http://127.0.0.1:${previewPort(port)}`
  await request('/page', {
    cookie: `${cookie}; t3m_session=secret; __Host-t3m_session=secret2; theme=dark`,
    origin,
    referer: `${origin}/home`,
    'x-forwarded-host': 'evil.example',
    'tailscale-user-login': 'someone@example.com',
  })
  expect(seen.host).toBe(`localhost:${port}`)
  expect(seen.origin).toBe(`http://localhost:${port}`)
  expect(seen.referer).toBe(`http://localhost:${port}/home`)
  expect(seen.cookie).toBe('theme=dark')
  expect(seen['x-forwarded-host']).toBeUndefined()
  expect(seen['tailscale-user-login']).toBeUndefined()
  // A redirect back to localhost lands on the preview; the app's cookie can't name localhost.
  const login = await request('/login', { cookie })
  expect(login.headers.location).toBe(`${origin}/dashboard`)
  expect(login.headers['set-cookie']).toEqual(['session=abc; Path=/; HttpOnly'])
})

it('refuses other addresses and other sites, passes live reload through, and closes', async () => {
  const { cookie } = await signIn()
  expect((await request('/', { cookie, host: `localhost:${previewPort(port)}` })).status).toBe(403)
  expect((await request('/', { cookie, origin: 'http://evil.example' })).status).toBe(403)
  // WebSocket (live reload) with the same rewriting.
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(previewPort(port), '127.0.0.1', () =>
      socket.write(
        `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${previewPort(port)}\r\nCookie: ${cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      ),
    )
    let data = ''
    socket.on('data', (chunk) => (data += chunk))
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
  expect(reply).toMatch(/^HTTP\/1\.1 101/)
  expect(seen.host).toBe(`localhost:${port}`)
  await previews.close(port)
  await expect(request('/', { cookie })).rejects.toThrow()
})

it('lands on the page that was tapped, and only on this preview', async () => {
  const { urls } = await previews.open(port, 'phone-1', '/settings/team?tab=members#invite')
  const pass = new URL(urls[0]!)
  const response = await request(`${pass.pathname}${pass.search}`)
  expect(response.status).toBe(303)
  expect(response.headers.location).toBe('/settings/team?tab=members#invite')
  // Anything that could leave the preview lands on its home page instead.
  for (const unsafe of [
    '//evil.example/x',
    '/\\evil.example',
    'https://evil.example',
    'dashboard',
    '/a b',
    '/x\u0000y',
  ])
    expect(landingPath(unsafe), unsafe).toBe('/')
  expect(landingPath('/login?next=%2Fhome')).toBe('/login?next=%2Fhome')
})
