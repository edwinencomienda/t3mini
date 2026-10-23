import { expect, it } from 'vitest'
import { reuseItems, reuseThread } from './reuse'
import type { Message, Thread } from './types'

const message = (id: string, text: string): Message => ({
  id,
  role: 'assistant',
  text,
  createdAt: '2026-10-24T00:00:00.000Z',
})
const thread = (id: string, messages: Message[]): Thread => ({
  id,
  title: 'Test',
  provider: 'claude',
  cwd: '/tmp',
  model: '',
  effort: '',
  permissionMode: 'full-access',
  status: 'working',
  createdAt: '',
  updatedAt: '',
  messages,
  activities: [],
  approvals: [],
})
// A fresh copy, as a live update delivers it (new objects, same content).
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

it('keeps unchanged items and takes changed or new ones', () => {
  const previous = [message('a', 'one'), message('b', 'two')]
  const next = fresh([message('a', 'one'), message('b', 'two, longer'), message('c', 'three')])
  const merged = reuseItems(previous, next)
  expect(merged[0]).toBe(previous[0])
  expect(merged[1]).toBe(next[1])
  expect(merged[2]).toBe(next[2])
})

it('returns the previous list itself when nothing changed', () => {
  const previous = [message('a', 'one'), message('b', 'two')]
  expect(reuseItems(previous, fresh(previous))).toBe(previous)
})

it('notices removed and reordered items', () => {
  const previous = [message('a', 'one'), message('b', 'two')]
  const removed = reuseItems(previous, fresh([previous[0]!]))
  expect(removed).not.toBe(previous)
  expect(removed).toEqual([previous[0]])
  const reordered = reuseItems(previous, fresh([previous[1]!, previous[0]!]))
  expect(reordered).not.toBe(previous)
  expect(reordered[0]).toBe(previous[1])
})

it('keys by a given field', () => {
  const previous = [{ path: '/a', name: 'A' }]
  expect(reuseItems(previous, fresh(previous), (item) => item.path)).toBe(previous)
})

it('keeps a streaming thread’s finished messages, not the one being written', () => {
  const previous = thread('t', [message('q', 'question'), message('r', 'Hel')])
  const next = fresh(thread('t', [message('q', 'question'), message('r', 'Hello')]))
  const merged = reuseThread(previous, next)
  expect(merged.messages[0]).toBe(previous.messages[0])
  expect(merged.messages[1]?.text).toBe('Hello')
})

it('takes another thread as it is', () => {
  const previous = thread('a', [message('q', 'question')])
  const next = fresh(thread('b', [message('q', 'question')]))
  expect(reuseThread(previous, next)).toBe(next)
})
