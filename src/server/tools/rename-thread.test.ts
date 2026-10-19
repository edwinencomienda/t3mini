import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { renameThread } from './rename-thread'
import { runTool } from '.'
import type { ToolContext } from './types'

const context = (rename: ToolContext['rename']): ToolContext => ({
  cwd: process.cwd(),
  attach: vi.fn(),
  saveImage: vi.fn(),
  processes: {} as never,
  browser: {} as never,
  saveHtml: async () => ({ id: 'x.html' }),
  saveMedia: async () => ({ id: 'x.mp4' }),
  rename,
})

it('renames the current thread', async () => {
  const rename = vi.fn(async (title: string) => title)
  const result = await runTool(renameThread, context(rename), { title: '  Fix login bug  ' })
  expect(rename).toHaveBeenCalledWith('Fix login bug')
  expect(result).toEqual({ ok: true, text: 'Renamed this thread to "Fix login bug".' })
})
it('refuses empty or overly long titles without renaming', async () => {
  const rename = vi.fn(async (title: string) => title)
  for (const title of ['   ', 'x'.repeat(121)])
    expect((await runTool(renameThread, context(rename), { title })).ok).toBe(false)
  expect(rename).not.toHaveBeenCalled()
})
it('only takes a title, so it cannot target another thread', () => {
  expect(Object.keys(z.object(renameThread.input).shape)).toEqual(['title'])
})
