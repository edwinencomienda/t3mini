import { expect, it } from 'vitest'
import { changedParts, checkRequest, ListPacer, listTimesEvery } from './api'
it('holds back a thread list whose only change is updatedAt, for a few seconds', () => {
  const pacer = new ListPacer()
  // A title that looks like the field must still count as a change of its own.
  const list = (updatedAt: string, status = 'working', title = 'Say "updatedAt":"x"') =>
    JSON.stringify([{ id: 'a', title, status, updatedAt }])
  expect(pacer.hold(list('1'), 0)).toBe(false)
  // A streaming reply bumps updatedAt: held.
  expect(pacer.hold(list('2'), 100)).toBe(true)
  expect(pacer.hold(list('3'), listTimesEvery - 1)).toBe(true)
  // Any other change goes out at once.
  expect(pacer.hold(list('4', 'completed'), listTimesEvery)).toBe(false)
  // Times alone still go out every listTimesEvery.
  expect(pacer.hold(list('5', 'completed'), listTimesEvery + 1)).toBe(true)
  expect(pacer.hold(list('6', 'completed'), listTimesEvery * 2)).toBe(false)
  expect(pacer.hold(list('6', 'completed', 'Say "updatedAt":"y"'), listTimesEvery * 2 + 1)).toBe(
    false,
  )
})
it('accepts same-origin loopback requests', () => {
  expect(() =>
    checkRequest(
      new Request('http://localhost:4310/api/threads', {
        method: 'POST',
        headers: { Origin: 'http://localhost:4310', 'Content-Type': 'application/json' },
      }),
    ),
  ).not.toThrow()
})
it('rejects cross-site agent commands and foreign hostnames', () => {
  expect(() =>
    checkRequest(
      new Request('http://localhost:4310/api/threads', {
        headers: { Origin: 'https://example.com' },
      }),
    ),
  ).toThrow('Cross-origin')
  expect(() => checkRequest(new Request('http://attacker.test/api/events'))).toThrow('localhost')
  expect(() =>
    checkRequest(
      new Request('http://localhost:4310/api/events', {
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
    ),
  ).toThrow('Cross-site')
})
it('rejects form submissions to mutation endpoints', () => {
  expect(() =>
    checkRequest(
      new Request('http://localhost:4310/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
      }),
    ),
  ).toThrow('application/json')
})
it('blocks Mac-only actions for requests from a paired phone', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  // Keep this test's service away from the real .data directory.
  process.env.T3_MINI_DATA_DIR = await mkdtemp(join(tmpdir(), 't3-mini-api-'))
  const { handleApi } = await import('./api')
  const remote = (path: string, method = 'POST') =>
    handleApi(
      new Request(`http://127.0.0.1:4310/api/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-t3-remote': '1' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      }),
    )
  for (const [path, method] of [
    ['remote', 'GET'],
    ['remote', 'POST'],
    ['remote/pair', 'POST'],
    ['push/apns', 'GET'],
    ['push/apns', 'POST'],
    ['folders/pick', 'POST'],
    ['threads/some-thread/open-editor', 'POST'],
    ['dictation', 'GET'],
    ['dictation', 'POST'],
    ['dictation', 'DELETE'],
    ['dictation/provider', 'POST'],
  ] as const)
    expect((await remote(path, method)).status).toBe(403)
  // Updates are offered on every device: a paired phone may check and run them.
  expect((await remote('app-update', 'GET')).status).toBe(200)
  expect((await remote('provider-updates/not-an-agent', 'POST')).status).not.toBe(403)
  expect((await remote('app-update/restart', 'POST')).status).not.toBe(403)
  // Another computer following this one asks whether you're here before pushing to your phone.
  const presence = await remote('presence', 'GET')
  expect(presence.status).toBe(200)
  expect(await presence.json()).toEqual({ atDesk: false })
  const bootstrap = await handleApi(
    new Request('http://127.0.0.1:4310/api/bootstrap', { headers: { 'x-t3-remote': '1' } }),
  )
  expect(await bootstrap.json()).toMatchObject({ remote: true, phoneAccess: false })
})
it('takes secrets from a phone only over HTTPS, and never echoes the value', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.T3_MINI_DATA_DIR ??= await mkdtemp(join(tmpdir(), 't3-mini-api-'))
  const { handleApi } = await import('./api')
  const send = (headers: Record<string, string>) =>
    handleApi(
      new Request('http://127.0.0.1:4310/api/threads/no-such-thread/secret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ approvalId: 'secret:x', value: 'sk-live-do-not-echo' }),
      }),
    )
  // A phone on the local network (plain HTTP): refused before anything else.
  const lan = await send({ 'x-t3-remote': '1', 'x-t3-transport': 'http' })
  expect(lan.status).toBe(403)
  expect(await lan.text()).toContain('isn’t encrypted')
  // Over Tailscale (HTTPS), or on the Mac itself: goes on (here to "thread not found").
  const allowed: Record<string, string>[] = [{ 'x-t3-remote': '1', 'x-t3-transport': 'https' }, {}]
  for (const headers of allowed) {
    const response = await send(headers)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('sk-live-do-not-echo')
  }
})
it('lists machines to a phone by name only, and keeps machine secrets off plain HTTP', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.T3_MINI_DATA_DIR ??= await mkdtemp(join(tmpdir(), 't3-mini-api-'))
  const { handleApi } = await import('./api')
  const phone = (path: string, method = 'GET', transport = 'http') =>
    handleApi(
      new Request(`http://127.0.0.1:4310/api/${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-t3-remote': '1',
          'x-t3-transport': transport,
        },
        ...(method === 'GET'
          ? {}
          : { body: JSON.stringify({ approvalId: 'secret:x', value: 'sk-x' }) }),
      }),
    )
  // The hub list is open to a paired device (no machines here: an empty list)…
  const hub = await phone('machines/hub')
  expect(hub.status).toBe(200)
  expect(await hub.json()).toEqual([])
  // …managing machines isn't.
  expect((await phone('machines')).status).toBe(403)
  // A secret for a machine's thread from a phone on the local network: refused before it's sent.
  const secret = await phone('m/some-machine/threads/t1/secret', 'POST')
  expect(secret.status).toBe(403)
  expect(await secret.text()).not.toContain('sk-x')
  // Over HTTPS it goes on (here to "that machine isn't added").
  expect((await phone('m/some-machine/threads/t1/secret', 'POST', 'https')).status).toBe(404)
})
it('hands a phone a dictation token only over HTTPS', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.T3_MINI_DATA_DIR ??= await mkdtemp(join(tmpdir(), 't3-mini-api-'))
  const { handleApi } = await import('./api')
  const response = await handleApi(
    new Request('http://127.0.0.1:4310/api/dictation/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-t3-remote': '1', 'x-t3-transport': 'http' },
      body: '{}',
    }),
  )
  expect(response.status).toBe(403)
})
it('ends a live-update stream nobody reads instead of queueing updates forever', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.T3_MINI_DATA_DIR ??= await mkdtemp(join(tmpdir(), 't3-mini-api-'))
  const { handleApi, maxQueuedUpdates } = await import('./api')
  const { getService } = await import('./service')
  const service = await getService()
  const stalled = await handleApi(new Request('http://127.0.0.1:4310/api/events'))
  const notify = () => (service as unknown as { notify(): void }).notify()
  // Each update changes what the tab sees, and nobody reads.
  for (let index = 0; index < maxQueuedUpdates * 2; index++) {
    service.ui.settings = { ...service.ui.settings, theme: index % 2 ? 'light' : 'dark' }
    notify()
    await new Promise((resolve) => setImmediate(resolve))
  }
  // What was queued is still there to read, then the stream ends.
  const reader = stalled.body!.getReader()
  let events = 0
  for (;;) {
    const { done } = await reader.read()
    if (done) break
    events++
  }
  expect(events).toBeLessThanOrEqual(maxQueuedUpdates + 2)
})
it('keeps HTTP statuses for errors from another copy of HttpError (dev hot reload)', async () => {
  const { isHttpError, handleApi } = await import('./api')
  // A second class with the same name, like the one a hot-reloaded service.ts produces.
  class HttpError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message)
    }
  }
  expect(isHttpError(new HttpError(404, 'Thread not found.'))).toBe(true)
  expect(isHttpError(Object.assign(new Error('x'), { status: 404 }))).toBe(false)
  const missing = await handleApi(new Request('http://127.0.0.1:4310/api/threads/missing-id'))
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ error: 'Thread not found.' })
})
it('serves agent HTML pages as sandboxed plain text, never as a page', async () => {
  const { handleApi } = await import('./api')
  const { getService } = await import('./service')
  const { id } = await (await getService()).uploads.saveHtml('<script>alert(1)</script>')
  const response = await handleApi(new Request(`http://127.0.0.1:4310/api/html/${id}`))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-security-policy')).toContain('sandbox')
  expect(await response.text()).toBe('<script>alert(1)</script>')
  const missing = await handleApi(new Request('http://127.0.0.1:4310/api/html/..%2Fui.json'))
  expect(missing.status).toBe(404)
})
it('serves the finished agent page for the iOS app, still as plain text', async () => {
  const { handleApi } = await import('./api')
  const { getService } = await import('./service')
  const { pagePolicy } = await import('../html-page')
  const { id } = await (await getService()).uploads.saveHtml('<p>Hello</p>')
  const page = (query: string) =>
    handleApi(new Request(`http://127.0.0.1:4310/api/html/${id}/page${query}`))
  const response = await page('?theme=dark&libraries=chart.js,evil.js')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(response.headers.get('content-security-policy')).toContain('sandbox')
  const text = await response.text()
  // Our policy comes first, the agent's HTML last, inside <body>.
  expect(text.indexOf(pagePolicy)).toBeGreaterThan(0)
  expect(text.indexOf(pagePolicy)).toBeLessThan(text.indexOf('<body><p>Hello</p>'))
  expect(text).toContain('color-scheme:dark')
  // Chart.js is inlined (it was asked for); an unknown library name is ignored.
  expect(text).toContain('t3Palette')
  expect(text).not.toContain('evil.js')
  const light = await (await page('?inline=0')).text()
  expect(light).toContain('color-scheme:light')
  expect(light).not.toContain('Chart.register')
  expect(await page('').then((r) => r.status)).toBe(200)
  const missing = await handleApi(new Request('http://127.0.0.1:4310/api/html/nope/page'))
  expect(missing.status).toBe(404)
})
it('sends each tab only the live-update parts that changed', () => {
  const sent = new Map<string, string>()
  const thread = { id: 'a', messages: [{ text: 'long history' }] }
  const snapshot = (threads: unknown[], extra = {}) => ({
    threads,
    thread,
    persistenceError: undefined,
    ...extra,
  })
  // Connecting: everything, with undefined sent as null.
  expect(JSON.parse(changedParts(sent, snapshot([{ id: 'a' }]))!)).toEqual({
    threads: [{ id: 'a' }],
    thread,
    persistenceError: null,
  })
  // Another thread streams: the list changes, the open thread isn't sent again.
  expect(
    JSON.parse(changedParts(sent, snapshot([{ id: 'a' }, { id: 'b', status: 'working' }]))!),
  ).toEqual({ threads: [{ id: 'a' }, { id: 'b', status: 'working' }] })
  // Nothing changed for this tab: nothing to send.
  expect(
    changedParts(sent, snapshot([{ id: 'a' }, { id: 'b', status: 'working' }])),
  ).toBeUndefined()
  // An error appearing is sent.
  expect(
    JSON.parse(
      changedParts(
        sent,
        snapshot([{ id: 'a' }, { id: 'b', status: 'working' }], {
          persistenceError: 'disk full',
        }),
      )!,
    ),
  ).toEqual({ persistenceError: 'disk full' })
})
