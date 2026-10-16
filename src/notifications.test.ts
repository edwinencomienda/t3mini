import { describe, expect, it } from 'vitest'
import { eventLabel, notifyingTab, tabStaleMs, threadEvents } from './notifications'
import type { Status, ThreadSummary } from './types'

const summary = (id: string, status: Status): ThreadSummary => ({
  id,
  title: `Thread ${id}`,
  provider: 'claude',
  cwd: '/tmp/project',
  status,
  updatedAt: '2026-10-15T00:00:00.000Z',
  lastMessageAt: '2026-10-15T00:00:00.000Z',
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

describe('notifyingTab', () => {
  const now = 1_000_000
  it('picks the most recently visited open tab', () => {
    expect(
      notifyingTab(
        {
          a: { visitedAt: now - 5_000, aliveAt: now },
          b: { visitedAt: now - 1_000, aliveAt: now },
          c: { visitedAt: 0, aliveAt: now },
        },
        now,
      ),
    ).toBe('b')
  })
  it('skips tabs that stopped checking in', () => {
    expect(
      notifyingTab(
        {
          a: { visitedAt: now - 5_000, aliveAt: now },
          b: { visitedAt: now - 1_000, aliveAt: now - tabStaleMs },
        },
        now,
      ),
    ).toBe('a')
  })
  it('falls back to a tab that was opened but never visited', () => {
    expect(notifyingTab({ a: { visitedAt: 0, aliveAt: now } }, now)).toBe('a')
  })
  it('has no answer without tabs, so each tab decides alone', () => {
    expect(notifyingTab({}, now)).toBeUndefined()
  })
})

it('says a thread has a question when it waits on one, else that it needs approval', () => {
  const waiting = (waitingFor?: 'approval' | 'question') => ({
    key: 'k',
    kind: 'waiting' as const,
    thread: { ...summary('a', 'waiting'), ...(waitingFor ? { waitingFor } : {}) },
  })
  expect(eventLabel(waiting('question'))).toBe('Has a question')
  expect(eventLabel(waiting('approval'))).toBe('Needs your approval')
  expect(eventLabel(waiting())).toBe('Needs your approval')
  expect(eventLabel({ key: 'k', kind: 'completed', thread: summary('a', 'completed') })).toBe(
    'Finished',
  )
})
