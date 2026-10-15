import { expect, it } from 'vitest'
import { threadEvents } from './notifications'
import type { Status, ThreadSummary } from './types'

const summary = (id: string, status: Status): ThreadSummary => ({
  id,
  title: `Thread ${id}`,
  provider: 'claude',
  cwd: '/tmp/project',
  status,
  updatedAt: '2026-10-15T00:00:00.000Z',
})
const statuses = (entries: [string, Status][]) => new Map(entries)

it('reports threads that finish, fail, or stop after running', () => {
  const events = threadEvents(
    statuses([
      ['a', 'working'],
      ['b', 'starting'],
      ['c', 'waiting'],
    ]),
    [summary('a', 'completed'), summary('b', 'failed'), summary('c', 'interrupted')],
  )
  expect(events.map((event) => [event.thread.id, event.kind])).toEqual([
    ['a', 'completed'],
    ['b', 'failed'],
    ['c', 'interrupted'],
  ])
})
it('reports threads that start waiting for approval', () => {
  expect(threadEvents(statuses([['a', 'working']]), [summary('a', 'waiting')])[0]?.kind).toBe(
    'waiting',
  )
})
it('ignores unchanged, newly seen, and non-turn transitions', () => {
  expect(
    threadEvents(
      statuses([
        ['a', 'working'],
        ['b', 'idle'],
        ['c', 'completed'],
      ]),
      [
        summary('a', 'working'),
        summary('b', 'completed'),
        summary('c', 'working'),
        summary('new', 'completed'),
      ],
    ),
  ).toEqual([])
})
