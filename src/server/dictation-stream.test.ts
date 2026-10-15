import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { allowedUpgrade, handleDictationUpgrade, streamPath } from './dictation-stream'

const upgrade = (headers: Record<string, string>, url = streamPath) =>
  ({ url, headers }) as unknown as IncomingMessage

it('accepts the local app opening the dictation stream', () => {
  for (const host of ['127.0.0.1:4310', 'localhost:4310', '[::1]:4310'])
    expect(allowedUpgrade(upgrade({ host, origin: `http://${host}` }))).toBe(true)
})
it('refuses other origins, hosts, paths, missing origins, and paired phones', () => {
  const host = '127.0.0.1:4310'
  expect(allowedUpgrade(upgrade({ host, origin: 'http://evil.example' }))).toBe(false)
  expect(allowedUpgrade(upgrade({ host }))).toBe(false)
  expect(
    allowedUpgrade(upgrade({ host: '192.168.1.5:4310', origin: 'http://192.168.1.5:4310' })),
  ).toBe(false)
  expect(allowedUpgrade(upgrade({ host, origin: `http://${host}` }, '/api/other'))).toBe(false)
  // The phone-access gateway rewrites host and origin to local ones but marks the request.
  expect(allowedUpgrade(upgrade({ host, origin: `http://${host}`, 'x-t3-remote': '1' }))).toBe(
    false,
  )
})
it('answers a refused upgrade with an HTTP error and never opens a stream', async () => {
  const socket = new PassThrough()
  let written = ''
  socket.on('data', (chunk) => (written += chunk))
  handleDictationUpgrade(
    upgrade({ host: '127.0.0.1:4310', origin: 'http://evil.example' }),
    socket,
    Buffer.alloc(0),
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(written).toMatch(/^HTTP\/1\.1 403 Forbidden/)
})
