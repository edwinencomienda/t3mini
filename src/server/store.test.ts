import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { saveDelay, ThreadStore } from './store'
import type { Thread } from '../types'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-store-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

const thread = (id: string, title: string) => ({ id, title, messages: [] }) as unknown as Thread
const saved = async (path: string) =>
  (JSON.parse(await readFile(path, 'utf8')) as Thread[]).map((item) => item.title)
const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  )

test('saveSoon writes once per delay, with the latest state, however many changes come in', async () => {
  vi.useFakeTimers()
  const store = new ThreadStore(join(directory, 'threads.json'))
  const save = vi.spyOn(store, 'save')
  store.threads.set('a', thread('a', 'one'))
  for (let index = 0; index < 10; index++) store.saveSoon(() => {})
  store.threads.get('a')!.title = 'two'
  await vi.advanceTimersByTimeAsync(saveDelay - 1)
  expect(save).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(save).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
  await save.mock.results[0]!.value
  expect(await saved(store.path)).toEqual(['two'])
})

test('save() takes over a pending saveSoon', async () => {
  vi.useFakeTimers()
  const store = new ThreadStore(join(directory, 'threads.json'))
  const save = vi.spyOn(store, 'save')
  store.threads.set('a', thread('a', 'one'))
  store.saveSoon(() => {})
  await store.save()
  await vi.advanceTimersByTimeAsync(saveDelay * 2)
  expect(save).toHaveBeenCalledTimes(1)
})

test('flushNow writes a pending save right away, and nothing when none is pending', async () => {
  const store = new ThreadStore(join(directory, 'threads.json'))
  store.threads.set('a', thread('a', 'one'))
  store.flushNow()
  expect(await exists(store.path)).toBe(false)
  store.saveSoon(() => {})
  store.flushNow()
  expect(await saved(store.path)).toEqual(['one'])
  expect(await exists(store.path + '.tmp')).toBe(false)
})

test('a failed saveSoon reports the error', async () => {
  vi.useFakeTimers()
  // A file can't be written inside a folder that is a file.
  const store = new ThreadStore(join(directory, 'threads.json', 'nested', 'threads.json'))
  await new ThreadStore(join(directory, 'threads.json')).save()
  const failed = vi.fn()
  store.saveSoon(failed)
  await vi.advanceTimersByTimeAsync(saveDelay)
  vi.useRealTimers()
  await vi.waitFor(() => expect(failed).toHaveBeenCalled())
})
