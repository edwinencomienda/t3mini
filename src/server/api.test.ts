import { expect, it } from 'vitest'
import { checkRequest } from './api'
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
    ['folders/pick', 'POST'],
    ['threads/some-thread/open-editor', 'POST'],
    ['dictation', 'GET'],
    ['dictation', 'POST'],
    ['dictation', 'DELETE'],
  ] as const)
    expect((await remote(path, method)).status).toBe(403)
  const bootstrap = await handleApi(
    new Request('http://127.0.0.1:4310/api/bootstrap', { headers: { 'x-t3-remote': '1' } }),
  )
  expect(await bootstrap.json()).toMatchObject({ remote: true, phoneAccess: false })
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
