import { expect, it } from 'vitest'
import { applyThreadPatch, ThreadDiff, type ThreadPatch } from './thread-patch'
import type { Thread } from './types'

const thread = (id: string, texts: string[], extra: Partial<Thread> = {}) =>
  ({
    id,
    title: 'Fix the login test',
    provider: 'claude',
    cwd: '~/projects/app',
    status: 'working',
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    messages: texts.map((text, index) => ({
      id: `m${index}`,
      role: index % 2 ? 'assistant' : 'user',
      text,
      createdAt: '2026-10-20T10:00:00.000Z',
    })),
    activities: [],
    approvals: [],
    ...extra,
  }) as unknown as Thread
// What the browser rebuilds from what the server sent, starting from nothing.
function follow(diff: ThreadDiff, base: Thread | null, next: Thread | null) {
  const sent = diff.next(next)
  if (!sent) return { base, sent }
  // Through JSON, like the real stream.
  const wire = JSON.parse(JSON.stringify(sent)) as {
    thread?: Thread | null
    threadPatch?: ThreadPatch
  }
  if ('threadPatch' in wire) return { base: applyThreadPatch(base!, wire.threadPatch!), sent }
  return { base: wire.thread ?? null, sent }
}

it('sends the whole thread once, then only the messages that changed', () => {
  const diff = new ThreadDiff()
  let state = follow(diff, null, thread('a', ['Fix it', 'Looking']))
  expect(state.sent).toHaveProperty('thread')
  // A reply grows: only that message is sent.
  const growing = thread('a', ['Fix it', 'Looking into it'])
  state = follow(diff, state.base, growing)
  expect(state.sent).toEqual({
    threadPatch: { id: 'a', messages: { count: 2, changed: [[1, growing.messages[1]]] } },
  })
  expect(state.base).toEqual(growing)
  // Nothing changed: nothing is sent.
  expect(diff.next(growing)).toBeUndefined()
  // A field changes (and one disappears): the fields are sent whole, no messages.
  const done = thread('a', ['Fix it', 'Looking into it'], { status: 'completed' })
  delete (done as { approvals?: unknown }).approvals
  state = follow(diff, state.base, done)
  expect(state.sent).toEqual({
    threadPatch: { id: 'a', rest: expect.objectContaining({ status: 'completed' }) },
  })
  expect(state.base).toEqual(done)
})
it('handles messages added and removed, and switching threads', () => {
  const diff = new ThreadDiff()
  let state = follow(diff, null, thread('a', ['one', 'two', 'three']))
  const before = state.base!
  // A stopped turn is edited away: the list gets shorter.
  state = follow(diff, state.base, thread('a', ['one']))
  expect(state.base).toEqual(thread('a', ['one']))
  // Unchanged messages stay the same objects in the browser.
  expect(state.base!.messages[0]).toBe(before.messages[0])
  state = follow(diff, state.base, thread('a', ['one', 'again', 'reply']))
  expect(state.base).toEqual(thread('a', ['one', 'again', 'reply']))
  // Another thread: whole again. No thread: null, once.
  state = follow(diff, state.base, thread('b', ['other']))
  expect(state.sent).toEqual({ thread: thread('b', ['other']) })
  expect(diff.next(null)).toEqual({ thread: null })
  expect(diff.next(null)).toBeUndefined()
})
it('starts a tab without an open thread with null', () => {
  expect(new ThreadDiff().next(null)).toEqual({ thread: null })
})
