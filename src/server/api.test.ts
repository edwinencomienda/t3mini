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
