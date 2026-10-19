import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Block } from '../../blocks'
import { Uploads, maxHtmlBytes } from '../uploads'
import { runTool } from './index'
import { showHtml } from './show-html'
import type { ToolContext } from './types'

const context = (uploads: Uploads) => {
  const attach = vi.fn<(block: Block) => void>()
  const value: ToolContext = {
    cwd: '/project',
    attach,
    saveImage: vi.fn(),
    processes: {} as never,
    browser: {} as never,
    saveHtml: (html) => uploads.saveHtml(html),
    saveMedia: async () => ({ id: 'x.mp4' }),
    readThread: async () => '',
    rename: vi.fn(),
  }
  return { attach, value }
}
const uploads = async () => new Uploads(await mkdtemp(join(tmpdir(), 't3-mini-html-')))

it('saves the page privately and shows it with its title', async () => {
  const store = await uploads()
  const { attach, value } = context(store)
  const html = '<h1>Hi</h1><script>document.body.append("ok")</script>'
  const result = await runTool(showHtml, value, { html, title: 'Greeting' })
  expect(result).toMatchObject({ ok: true, text: 'Shown to the user: Greeting.' })
  const block = attach.mock.calls[0][0] as Extract<Block, { type: 'html' }>
  expect(block).toEqual({ type: 'html', id: expect.stringMatching(/\.html$/), title: 'Greeting' })
  expect(await store.readHtml(block.id)).toBe(html)
  expect((await stat(join(store.directory, 'html', block.id))).mode & 0o777).toBe(0o600)
})

it('refuses empty and oversized pages', async () => {
  const { attach, value } = context(await uploads())
  expect(await runTool(showHtml, value, { html: '   ' })).toMatchObject({
    ok: false,
    text: expect.stringContaining('empty'),
  })
  expect(await runTool(showHtml, value, { html: 'x'.repeat(maxHtmlBytes + 1) })).toMatchObject({
    ok: false,
    text: expect.stringContaining('KB'),
  })
  expect(attach).not.toHaveBeenCalled()
})

it('reads only page ids, never other paths', async () => {
  const store = await uploads()
  for (const id of ['../secrets.json', '..%2Fsecrets.json', 'abc.html', 'x'])
    await expect(store.readHtml(id)).rejects.toThrow('Invalid page')
})
