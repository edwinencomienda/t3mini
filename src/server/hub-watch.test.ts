import { afterEach, expect, it, vi } from 'vitest'
import { HubWatch, hubId, parseHubId } from './hub-watch'
import { watchThreads } from './push'
import type { ThreadSummary } from '../types'

// A fake machine: its live updates are pushed by the test; whole threads and read marks answer
// from a map. Nothing leaves the process.
function fakeMachine() {
  let send: (data: unknown) => void = () => {}
  const calls: { path: string; method: string }[] = []
  const threads = new Map<string, Record<string, unknown>>()
  const source = {
    list: async () => [
      {
        id: 'vps1',
        name: 'vps',
        origin: 'https://vps.example.ts.net:8443',
        addedAt: '',
        url: '',
        status: 'online' as const,
      },
    ],
    forward: async (_machine: string, path: string, request: Request) => {
      calls.push({ path, method: request.method })
      if (path === 'events') {
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            send = (data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
            request.signal.addEventListener('abort', () => controller.close())
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      const thread = threads.get(decodeURIComponent(path.replace(/^threads\//, '')))
      if (path.endsWith('/read') || !thread) return Response.json({ ok: true })
      return Response.json(thread)
    },
  }
  return { source, calls, threads, send: (data: unknown) => send(data) }
}
const summary = (id: string, status: ThreadSummary['status'], updatedAt = '1') =>
  ({ id, title: id, provider: 'claude', cwd: '/srv/app', status, updatedAt }) as ThreadSummary
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

let hub: HubWatch | undefined
afterEach(() => hub?.stop())

it('reads hub ids like the web and the iPhone app', () => {
  expect(hubId('vps1', '/srv/app')).toBe('m~vps1~/srv/app')
  expect(parseHubId('m~vps1~/srv/app')).toEqual({ machine: 'vps1', id: '/srv/app' })
  expect(parseHubId('t1')).toBeNull()
  expect(parseHubId('m~~t1')).toBeNull()
})

it('follows a machine’s threads with hub ids, and pushes the ones that finish', async () => {
  const machine = fakeMachine()
  hub = new HubWatch(machine.source)
  await hub.refresh()
  await settle()
  machine.send({
    threads: [summary('t1', 'working'), summary('t2', 'working')],
    projects: [{ path: '/srv/app', name: 'app' }],
  })
  await settle()
  expect(hub.list().map((item) => [item.id, item.cwd, item.machine])).toEqual([
    ['m~vps1~t1', 'm~vps1~/srv/app', 'vps'],
    ['m~vps1~t2', 'm~vps1~/srv/app', 'vps'],
  ])
  expect(hub.projectName('m~vps1~/srv/app')).toBe('app · vps')

  vi.useFakeTimers()
  try {
    const queued: { title: string; url: string; body: string }[] = []
    const watched: string[] = []
    watchThreads(
      {
        subscribe: (listener) => hub!.subscribe(listener),
        list: () => hub!.list(),
        // You're looking at t2 in a tab here.
        isWatching: (id) => id === 'm~vps1~t2',
        projectName: (cwd) => hub!.projectName(cwd),
        watched: (event) => watched.push(event.thread.id),
      },
      { queue: (payload) => void queued.push(payload) },
    )
    machine.send({ threads: [summary('t1', 'completed', '2'), summary('t2', 'completed', '2')] })
    await vi.advanceTimersByTimeAsync(600)
    // t1 is pushed, opening its hub thread; t2 isn't (you watched it) and gets marked read.
    expect(queued).toEqual([
      expect.objectContaining({ title: 't1', body: 'Done · app · vps', url: '/threads/m~vps1~t1' }),
    ])
    expect(watched).toEqual(['m~vps1~t2'])
  } finally {
    vi.useRealTimers()
  }
})

it('keeps a followed thread whole and current, and marks threads read on the machine', async () => {
  const machine = fakeMachine()
  hub = new HubWatch(machine.source)
  await hub.refresh()
  await settle()
  machine.threads.set('t1', { ...summary('t1', 'working'), messages: [], activities: [] })
  const loaded = await hub.load('m~vps1~t1')
  expect(loaded).toMatchObject({ id: 'm~vps1~t1', cwd: 'm~vps1~/srv/app', status: 'working' })
  // It changes on the machine: the list update fetches the whole thread again.
  machine.threads.set('t1', { ...summary('t1', 'completed', '2'), messages: [], activities: [] })
  machine.send({ threads: [summary('t1', 'completed', '2')] })
  await settle()
  expect(hub.thread('m~vps1~t1')?.status).toBe('completed')
  await hub.markRead('m~vps1~t1')
  expect(machine.calls).toContainEqual({ path: 'threads/t1/read', method: 'POST' })
  // Not a machine's thread: nothing is fetched.
  expect(await hub.load('t1')).toBeUndefined()
})

it('keeps each machine’s agent updates and t3mini install, and says when they change', async () => {
  const machine = fakeMachine()
  hub = new HubWatch(machine.source)
  const changed = vi.fn()
  hub.onUpdates(changed)
  await hub.refresh()
  await settle()
  // A machine on an older t3mini sends neither: nothing to show.
  machine.send({ threads: [summary('t1', 'idle')] })
  await settle()
  expect(hub.updates()).toEqual([])
  expect(changed).not.toHaveBeenCalled()
  const codex = {
    provider: 'codex',
    installed: '0.50.0',
    latest: '0.52.0',
    available: true,
    updating: false,
  }
  machine.send({ providerUpdates: [codex], appUpdate: { ready: true, whenIdle: false } })
  await settle()
  expect(hub.updates()).toEqual([
    {
      machine: 'vps1',
      name: 'vps',
      providerUpdates: [codex],
      appUpdate: { ready: true, whenIdle: false },
      running: 0,
    },
  ])
  expect(changed).toHaveBeenCalledTimes(1)
  // Its running agents count (restarting would stop them): told when that changes, not on every
  // thread update.
  machine.send({ threads: [summary('t1', 'working')] })
  await settle()
  expect(hub.updates()[0]?.running).toBe(1)
  expect(changed).toHaveBeenCalledTimes(2)
  machine.send({ threads: [summary('t1', 'working', '2')] })
  await settle()
  expect(changed).toHaveBeenCalledTimes(2)
})
