import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pickProjectFolder } from './folder-picker'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-folder-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('returns the full canonical folder path chosen on the computer', async () => {
  const dialog = vi.fn(async () => directory + '/')
  expect(await pickProjectFolder({ cwd: directory }, dialog)).toEqual({
    path: await realpath(directory),
  })
  expect(dialog).toHaveBeenCalledWith(directory)
})
it('leaves selection unchanged when the user cancels', async () => {
  expect(await pickProjectFolder({ cwd: directory }, async () => '')).toEqual({ path: null })
})
it('starts at home when the typed path does not exist', async () => {
  const dialog = vi.fn(async () => '')
  await pickProjectFolder({ cwd: join(directory, 'missing') }, dialog)
  expect(dialog).toHaveBeenCalledWith(homedir())
})
it('expands home paths before opening the chooser', async () => {
  const dialog = vi.fn(async () => '')
  await pickProjectFolder({ cwd: '~' }, dialog)
  expect(dialog).toHaveBeenCalledWith(homedir())
})
it('prevents duplicate native windows and releases the lock after cancellation', async () => {
  let cancel!: (value: string) => void
  const first = pickProjectFolder(
    {},
    () =>
      new Promise((resolve) => {
        cancel = resolve
      }),
  )
  await expect(pickProjectFolder({}, async () => '')).rejects.toThrow('already open')
  // The first chooser reaches the dialog synchronously when no starting path is supplied.
  cancel('')
  await first
  expect(await pickProjectFolder({}, async () => '')).toEqual({ path: null })
})
it('recovers from dialog failure and rejects file selections', async () => {
  await expect(
    pickProjectFolder({}, async () => {
      throw new Error('native error')
    }),
  ).rejects.toThrow('Could not open')
  const file = join(directory, 'file.txt')
  await writeFile(file, '')
  await expect(pickProjectFolder({}, async () => file)).rejects.toThrow('Could not open')
  expect(await pickProjectFolder({}, async () => directory)).toEqual({
    path: await realpath(directory),
  })
})
