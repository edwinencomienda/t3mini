import { expect, it } from 'vitest'
import { threadFromPushUrl } from './push'

it('opens only thread paths from a tapped notification', () => {
  expect(threadFromPushUrl('/threads/4cb511d1-ccb7-4b58-8928-558bf77c8187')).toBe(
    '4cb511d1-ccb7-4b58-8928-558bf77c8187',
  )
  expect(threadFromPushUrl('/threads/a%20b')).toBe('a b')
  for (const other of [
    '/',
    '/threads/',
    '/threads/a/b',
    'https://evil.example/threads/a',
    '//evil.example/threads/a',
    '/threads/%E0%A4%A',
    42,
    null,
  ])
    expect(threadFromPushUrl(other), String(other)).toBeNull()
})
