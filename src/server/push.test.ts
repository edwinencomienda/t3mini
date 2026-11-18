import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { allowedPushHost, PushNotifications, pushFor, watchThreads, type PushSender } from './push'
import type { ThreadSummary } from '../types'

let directory: string
let sent: { endpoint: string; payload: unknown; options: Record<string, unknown> }[]
let failWith: number | undefined
const sender: PushSender = async (subscription, payload, options) => {
  if (failWith) throw Object.assign(new Error('push failed'), { statusCode: failWith })
  sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options })
}
const apple = 'https://web.push.apple.com/QGabc123'
const keys = {
  p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-push-'))
  sent = []
  failWith = undefined
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
const store = (devices = new Set<string>(['phone'])) =>
  new PushNotifications(join(directory, 'push.json'), {
    send: sender,
    subject: 'mailto:test@example.com',
    deviceExists: (id) => devices.has(id),
  })

it('only talks to the browsers’ push services', () => {
  expect(allowedPushHost('https://web.push.apple.com/abc')).toBe(true)
  expect(allowedPushHost('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
  expect(allowedPushHost('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true)
  expect(allowedPushHost('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe(true)
  for (const bad of [
    'http://web.push.apple.com/abc',
    'https://127.0.0.1/abc',
    'https://localhost:4016/api/threads',
    'https://web.push.apple.com.evil.example/abc',
    'https://evil.example/web.push.apple.com',
    'https://user:pw@web.push.apple.com/abc',
    'https://web.push.apple.com:8443/abc',
    'not a url',
  ])
    expect(allowedPushHost(bad), bad).toBe(false)
})
it('keeps its keys and subscriptions private, and refuses other addresses', async () => {
  const push = store()
  const key = await push.publicKey()
  expect(key).toMatch(/^[\w-]{80,}$/)
  await push.subscribe({ endpoint: apple, keys }, 'phone')
  await push.subscribe({ endpoint: apple, keys }, 'phone') // same browser again: one entry
  await expect(push.subscribe({ endpoint: 'https://127.0.0.1:4016/api/x', keys })).rejects.toThrow()
  await expect(
    push.subscribe({ endpoint: apple, keys: { p256dh: '<script>', auth: 'x' } }),
  ).rejects.toThrow()
  expect((await stat(join(directory, 'push.json'))).mode & 0o777).toBe(0o600)
  const saved = JSON.parse(await readFile(join(directory, 'push.json'), 'utf8'))
  expect(saved.subscriptions).toHaveLength(1)
  expect(saved.publicKey).toBe(key)
  expect(await push.subscribed(apple)).toBe(true)
  // A new instance reads the same keys.
  expect(await store().publicKey()).toBe(key)
})
it('sends encrypted-for-the-browser messages, and drops gone and revoked subscribers', async () => {
  const devices = new Set(['phone', 'tablet'])
  const push = store(devices)
  await push.subscribe({ endpoint: apple, keys }, 'phone')
  await push.subscribe({ endpoint: 'https://web.push.apple.com/tablet', keys }, 'tablet')
  await push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/mac', keys })
  const payload = { title: 'Fix login', body: 'Done · app', url: '/threads/t1', tag: 't1' }
  await push.send(payload)
  expect(sent.map((item) => item.endpoint).sort()).toHaveLength(3)
  expect(sent[0]!.payload).toEqual(payload)
  expect(sent[0]!.options).toMatchObject({ urgency: 'high', topic: 't1' })
  // The tablet was revoked: it gets nothing more, and its subscription goes.
  devices.delete('tablet')
  sent = []
  await push.send(payload)
  expect(sent.map((item) => item.endpoint)).not.toContain('https://web.push.apple.com/tablet')
  expect(await push.subscribed('https://web.push.apple.com/tablet')).toBe(false)
  // The push service says a subscription is gone (410): dropped.
  failWith = 410
  await push.send(payload)
  expect(await push.subscribed(apple)).toBe(false)
})
it('removes a revoked device’s subscriptions, or every paired device’s', async () => {
  const push = store()
  await push.subscribe({ endpoint: apple, keys }, 'phone')
  await push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/mac', keys })
  await push.removeDevice('phone')
  expect(await push.subscribed(apple)).toBe(false)
  expect(await push.subscribed('https://fcm.googleapis.com/fcm/send/mac')).toBe(true)
  await push.subscribe({ endpoint: apple, keys }, 'phone')
  await push.removeDevice()
  expect(await push.subscribed(apple)).toBe(false)
  expect(await push.subscribed('https://fcm.googleapis.com/fcm/send/mac')).toBe(true)
})
it('pushes finished, failed, and waiting threads you aren’t looking at', async () => {
  vi.useFakeTimers()
  try {
    const thread = (
      id: string,
      status: ThreadSummary['status'],
      extra: Partial<ThreadSummary> = {},
    ) =>
      ({
        id,
        title: id,
        provider: 'claude',
        cwd: '/p/app',
        status,
        updatedAt: 'x',
        lastMessageAt: 'x',
        ...extra,
      }) as ThreadSummary
    let threads = [
      thread('a', 'working'),
      thread('b', 'working'),
      thread('c', 'working'),
      thread('d', 'working'),
      thread('e', 'working', { parentId: 'a' }),
      thread('f', 'working'),
    ]
    let listener = () => {}
    const queued: unknown[] = []
    watchThreads(
      {
        subscribe: (next) => ((listener = next), () => {}),
        list: () => threads,
        isWatching: (id) => id === 'd',
        projectName: () => 'app',
      },
      { queue: (payload) => void queued.push(payload) },
    )
    threads = [
      thread('a', 'completed'),
      thread('b', 'failed'),
      thread('c', 'waiting', { waitingFor: 'question' }),
      thread('d', 'completed'), // you're looking at it
      thread('e', 'completed', { parentId: 'a' }), // a helper: it reports to its lead
      thread('f', 'interrupted'), // you stopped it
    ]
    listener()
    listener()
    await vi.advanceTimersByTimeAsync(600)
    expect(queued).toEqual([
      { title: 'a', body: 'Done · app', url: '/threads/a', tag: 'a' },
      { title: 'b', body: 'Failed · app', url: '/threads/b', tag: 'b' },
      { title: 'c', body: 'Has a question · app', url: '/threads/c', tag: 'c' },
    ])
  } finally {
    vi.useRealTimers()
  }
})
it('words an approval wait like the web app', () => {
  const thread = {
    id: 't',
    title: '',
    provider: 'codex',
    cwd: '/p',
    status: 'waiting',
    updatedAt: '',
    lastMessageAt: '',
  } as ThreadSummary
  expect(pushFor({ key: 'k', thread, kind: 'waiting' }, 'app')).toEqual({
    title: 'Thread',
    body: 'Needs your approval · app',
    url: '/threads/t',
    tag: 't',
  })
})
