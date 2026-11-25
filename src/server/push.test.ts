import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  allowedPushHost,
  AwayPush,
  PushNotifications,
  pushFor,
  watchThreads,
  type PushSender,
} from './push'
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
  const payload = {
    title: 'Fix login',
    body: 'Done · app',
    url: '/threads/t1',
    tag: 't1',
    brief: 'A thread finished.',
  }
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
      { title: 'a', body: 'Done · app', url: '/threads/a', tag: 'a', brief: 'A thread finished.' },
      { title: 'b', body: 'Failed · app', url: '/threads/b', tag: 'b', brief: 'A thread failed.' },
      {
        title: 'c',
        body: 'Has a question · app',
        url: '/threads/c',
        tag: 'c',
        brief: 'A thread has a question for you.',
      },
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
    brief: 'A thread needs your approval.',
  })
})
it('skips the browsers you’re using t3 mini in right now, and keeps their subscriptions', async () => {
  const push = store()
  const mac = 'https://web.push.apple.com/mac'
  await push.subscribe({ endpoint: mac, keys })
  await push.subscribe({ endpoint: apple, keys }, 'phone')
  const payload = {
    title: 'Fix login',
    body: 'Done · app',
    url: '/threads/t1',
    tag: 't1',
    brief: 'A thread finished.',
  }
  await push.send(payload, new Set([mac]))
  expect(sent.map((item) => item.endpoint)).toEqual([apple])
  expect(await push.subscribed(mac)).toBe(true)
})

const payload = {
  title: 'Fix login',
  body: 'Done · app',
  url: '/threads/t1',
  tag: 't1',
  brief: 'A thread finished.',
}

it('sends to this Mac’s browsers only, or to the devices you carry away from it', async () => {
  const push = store()
  const mac = 'https://web.push.apple.com/mac'
  await push.subscribe({ endpoint: mac, keys })
  await push.subscribe({ endpoint: apple, keys }, 'phone')
  await push.send(payload, new Set(), 'here')
  expect(sent.map((item) => item.endpoint)).toEqual([mac])
  sent = []
  await push.send(payload, new Set(), 'away')
  expect(sent.map((item) => item.endpoint)).toEqual([apple])
  sent = []
  await push.send(payload)
  expect(sent.map((item) => item.endpoint).sort()).toEqual([apple, mac].sort())
})

it('keeps phones quiet while you’re at the Mac, and pushes once you leave (like Slack)', async () => {
  vi.useFakeTimers()
  try {
    const queued: string[] = []
    let atDesk = true
    let unread = true
    let mode: 'away' | 'always' = 'away'
    const away = new AwayPush({
      push: { queue: (_payload, _skip, targets = 'all') => void queued.push(targets) },
      atDesk: async () => atDesk,
      mode: () => mode,
      recheckMs: 1000,
      holdMs: 10_000,
    })
    const tick = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
    }
    // At the Mac: the Mac's browsers get it now, phones wait.
    await away.deliver(payload, new Set(), () => unread)
    expect(queued).toEqual(['here'])
    await tick(3000)
    expect(queued).toEqual(['here'])
    // You leave with the thread still unread: phones get it at the next check.
    atDesk = false
    await tick(1000)
    expect(queued).toEqual(['here', 'away'])
    expect(away.holding()).toEqual([])

    // Opened before you left: nothing goes to phones.
    queued.length = 0
    atDesk = true
    await away.deliver(payload, new Set(), () => unread)
    unread = false
    atDesk = false
    await tick(2000)
    expect(queued).toEqual(['here'])
    expect(away.holding()).toEqual([])

    // Still at the Mac after the hold: dropped, not sent hours later.
    queued.length = 0
    unread = true
    atDesk = true
    await away.deliver(payload, new Set(), () => unread)
    await tick(12_000)
    atDesk = false
    await tick(2000)
    expect(queued).toEqual(['here'])

    // Away, or "Always": every device right away.
    queued.length = 0
    atDesk = false
    await away.deliver(payload, new Set(), () => true)
    mode = 'always'
    atDesk = true
    await away.deliver(payload, new Set(), () => true)
    expect(queued).toEqual(['all', 'all'])
    away.stop()
  } finally {
    vi.useRealTimers()
  }
})

it('holds a finished thread for phones only until you open it', async () => {
  const queued: { tag: string; targets: string }[] = []
  let threads: ThreadSummary[] = [
    {
      id: 't1',
      title: 'Fix login',
      provider: 'claude',
      cwd: '/app',
      status: 'working',
      updatedAt: '1',
    } as ThreadSummary,
  ]
  const listeners = new Set<() => void>()
  let atDesk = true
  const away = new AwayPush({
    push: { queue: (item, _skip, targets = 'all') => void queued.push({ tag: item.tag, targets }) },
    atDesk: async () => atDesk,
    mode: () => 'away',
    recheckMs: 20,
  })
  const stop = watchThreads(
    {
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      list: () => threads,
      isWatching: () => false,
      projectName: () => 'app',
    },
    { queue: () => {} },
    0,
    away,
  )
  const change = async (next: ThreadSummary[]) => {
    threads = next
    listeners.forEach((listener) => listener())
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await change([{ ...threads[0]!, status: 'completed', updatedAt: '2', unread: true }])
  expect(queued).toEqual([{ tag: 't1', targets: 'here' }])
  // You open it on the Mac (no longer unread), then leave: phones stay quiet.
  await change([{ ...threads[0]!, unread: false }])
  atDesk = false
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(queued).toEqual([{ tag: 't1', targets: 'here' }])
  stop()
  away.stop()
})

it('asks about the thread’s own computer: quiet while you’re at the machine it ran on', async () => {
  const queued: string[] = []
  const asked: string[] = []
  const away = new AwayPush({
    push: { queue: (_payload, _skip, targets = 'all') => void queued.push(targets) },
    // You're at the machine "vps1", not at this Mac.
    atDesk: async (thread) => {
      asked.push(thread)
      return thread.startsWith('m~vps1~')
    },
    mode: () => 'away',
  })
  await away.deliver({ ...payload, tag: 'm~vps1~t9' }, new Set(), () => true)
  await away.deliver({ ...payload, tag: 'here-1' }, new Set(), () => true)
  expect(asked).toEqual(['m~vps1~t9', 'here-1'])
  expect(queued).toEqual(['here', 'all'])
  away.stop()
})
