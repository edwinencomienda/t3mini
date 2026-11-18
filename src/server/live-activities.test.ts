import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ApnsMessage, ApnsResult } from './apns'
import { activityState, LiveActivities } from './live-activities'
import type { Status, Thread } from '../types'

let directory: string
let sent: ApnsMessage[]
let result: ApnsResult
let now: number
let threads: Map<string, Thread>
let devices: Set<string>
const config = { teamId: 'ABCDE12345', keyId: 'KEY1234567', key: 'unused' }
const token = 'ab'.repeat(80)
const at = (iso: string) => Date.parse(iso) / 1000
const started = at('2026-11-18T09:59:50.000Z')

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-activities-'))
  sent = []
  result = 'sent'
  now = Date.parse('2026-11-18T10:00:00.000Z')
  threads = new Map()
  devices = new Set(['phone'])
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const thread = (status: Status, steps = 0, extra: Partial<Thread> = {}): Thread =>
  ({
    id: 't1',
    title: 'Secret project plan',
    provider: 'claude',
    cwd: '/tmp/app',
    status,
    createdAt: '2026-11-18T09:59:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z',
    messages: [
      { id: 'm1', role: 'user', text: 'run the tests', createdAt: '2026-11-18T09:59:50.000Z' },
    ],
    activities: Array.from({ length: steps }, (_, index) => ({
      id: `s${index}`,
      label: 'Run',
      status: 'completed',
    })),
    approvals: [],
    ...extra,
  }) as unknown as Thread

const store = (withConfig = true) =>
  new LiveActivities(join(directory, 'live-activities.json'), {
    thread: (id) => threads.get(id),
    apns: {
      config: async () => (withConfig ? config : null),
      send: async (_config, message) => {
        sent.push(message)
        return result
      },
    },
    deviceExists: (id) => devices.has(id),
    now: () => now,
  })
const register = (activities: LiveActivities, input: Record<string, unknown> = {}) =>
  activities.register(
    { token, thread: 't1', environment: 'sandbox', topic: 'com.example.t3mini', ...input },
    'phone',
  )

it('maps a thread to what the activity shows', () => {
  expect(activityState(thread('working', 3))).toEqual({
    status: 'working',
    steps: 3,
    startedAt: started,
  })
  expect(activityState(thread('waiting')).status).toBe('waiting')
  expect(activityState(thread('interrupted')).status).toBe('stopped')
  const done = activityState(thread('completed', 2, { completedAt: '2026-11-18T10:02:10.000Z' }))
  expect(done).toEqual({
    status: 'done',
    steps: 2,
    startedAt: started,
    endedAt: at('2026-11-18T10:02:10.000Z'),
  })
})

it('registers only real threads and valid tokens, privately', async () => {
  const activities = store()
  await expect(register(activities)).rejects.toThrow('Thread not found')
  threads.set('t1', thread('working'))
  await expect(register(activities, { token: 'not-hex' })).rejects.toThrow()
  await expect(register(activities, { topic: 'bad topic' })).rejects.toThrow()
  await register(activities)
  expect(await activities.registered(token.toUpperCase())).toBe(true)
  expect((await stat(join(directory, 'live-activities.json'))).mode & 0o777).toBe(0o600)
})

it('sends status changes at once and step counts at most every 15 seconds, with no text', async () => {
  threads.set('t1', thread('working', 1))
  const activities = store()
  await register(activities)
  await activities.update()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    topic: 'com.example.t3mini.push-type.liveactivity',
    pushType: 'liveactivity',
    priority: 10,
    environment: 'sandbox',
  })
  expect(sent[0]!.payload).toEqual({
    aps: {
      timestamp: now / 1000,
      event: 'update',
      'content-state': { status: 'working', steps: 1, startedAt: started },
    },
  })
  // Nothing about the thread's title, project, or work goes through Apple.
  const body = JSON.stringify(sent[0]!.payload)
  for (const secret of ['Secret', '/tmp/app', 'run the tests', 'Run'])
    expect(body).not.toContain(secret)

  // More steps: held back for 15 s, then sent quietly.
  threads.set('t1', thread('working', 4))
  now += 5_000
  await activities.update()
  expect(sent).toHaveLength(1)
  now += 11_000
  await activities.update()
  expect(sent).toHaveLength(2)
  expect(sent[1]).toMatchObject({ priority: 5 })

  // Waiting for you: at once.
  threads.set('t1', thread('waiting', 4))
  now += 1_000
  await activities.update()
  expect(sent).toHaveLength(3)
  expect(
    (sent[2]!.payload as { aps: { 'content-state': { status: string } } }).aps['content-state']
      .status,
  ).toBe('waiting')
})

it('ends the activity when the turn ends, showing the result for 15 minutes', async () => {
  threads.set('t1', thread('working'))
  const activities = store()
  await register(activities)
  await activities.update()
  threads.set('t1', thread('completed', 2, { completedAt: '2026-11-18T10:02:10.000Z' }))
  await activities.update()
  const end = sent[1]!.payload as { aps: Record<string, unknown> }
  expect(end.aps.event).toBe('end')
  expect(end.aps['dismissal-date']).toBe(now / 1000 + 15 * 60)
  expect(await activities.registered(token)).toBe(false)
})

it('waits for a just-sent message to start before ending anything', async () => {
  threads.set('t1', thread('completed'))
  const activities = store()
  await register(activities)
  await activities.update()
  expect(sent).toHaveLength(0)
  now += 31_000
  await activities.update()
  expect((sent[0]!.payload as { aps: { event: string } }).aps.event).toBe('end')
})

it('drops tokens Apple says are gone, from revoked devices, and when push isn’t set up sends nothing', async () => {
  threads.set('t1', thread('working'))
  const quiet = store(false)
  await register(quiet)
  await quiet.update()
  expect(sent).toHaveLength(0)
  expect(await quiet.registered(token)).toBe(true)

  const activities = store()
  result = 'gone'
  await activities.update()
  expect(await activities.registered(token)).toBe(false)

  result = 'sent'
  await register(activities)
  devices.delete('phone')
  await activities.update()
  expect(await activities.registered(token)).toBe(false)

  devices.add('phone')
  await register(activities)
  await activities.removeDevice('phone')
  expect(await activities.registered(token)).toBe(false)
})
