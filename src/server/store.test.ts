import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

// Complete enough that loading it changes nothing (so a reload has nothing to rewrite).
const thread = (id: string, title: string) =>
  ({ id, title, messages: [], effort: '', permissionMode: 'default' }) as unknown as Thread
// The titles of the threads on disk (one file each in the store's folder), sorted.
const saved = async (path: string) => {
  const folder = path.replace(/\.json$/, '')
  const names = (await readdir(folder)).filter((name) => name.endsWith('.json'))
  const threads = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(folder, name), 'utf8')) as Thread),
  )
  return threads.map((item) => item.title).sort()
}
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
  expect(await readdir(store.folder)).toEqual(['a.json'])
})

test('a failed saveSoon reports the error', async () => {
  vi.useFakeTimers()
  // A file can't be written inside a folder that is a file.
  const store = new ThreadStore(join(directory, 'threads.json', 'nested', 'threads.json'))
  store.threads.set('a', thread('a', 'one'))
  await writeFile(join(directory, 'threads.json'), '')
  const failed = vi.fn()
  store.saveSoon(failed)
  await vi.advanceTimersByTimeAsync(saveDelay)
  vi.useRealTimers()
  await vi.waitFor(() => expect(failed).toHaveBeenCalled())
})

test('writes only the threads that changed, and removes the files of deleted ones', async () => {
  const store = new ThreadStore(join(directory, 'threads.json'))
  store.threads.set('a', thread('a', 'one'))
  store.threads.set('b', thread('b', 'two'))
  await store.save()
  const written = async (id: string) => (await stat(join(store.folder, `${id}.json`))).mtimeMs
  const before = await written('b')
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.threads.get('a')!.title = 'changed'
  await store.save()
  expect(await written('b')).toBe(before)
  expect(await saved(store.path)).toEqual(['changed', 'two'])
  store.threads.delete('a')
  await store.save()
  expect(await saved(store.path)).toEqual(['two'])
  // A fresh load sees the same, and doesn't rewrite what's already there.
  const reloaded = new ThreadStore(store.path)
  await reloaded.load()
  expect([...reloaded.threads.keys()]).toEqual(['b'])
  await reloaded.save()
  expect(await written('b')).toBe(before)
})

test('moves the old single file into the folder once, keeping it as a backup', async () => {
  const path = join(directory, 'threads.json')
  await writeFile(path, JSON.stringify([thread('a', 'one'), thread('b/../x', 'two')]))
  const store = new ThreadStore(path)
  await store.load()
  expect([...store.threads.keys()]).toEqual(['a', 'b/../x'])
  expect(await saved(path)).toEqual(['one', 'two'])
  // An id can't reach outside the folder.
  expect((await readdir(store.folder)).sort()).toEqual(['a.json', 'b%2F..%2Fx.json'])
  expect(await exists(path)).toBe(false)
  expect(await exists(path + '.migrated')).toBe(true)
  // Later loads read the folder.
  const again = new ThreadStore(path)
  await again.load()
  expect(again.threads.size).toBe(2)
})
