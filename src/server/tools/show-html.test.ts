import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Block } from '../../blocks'
import { Uploads, maxHtmlBytes } from '../uploads'
import { runTool } from './index'
import { showHtml } from './show-html'
import type { ToolContext } from './types'

const rendered = {
  image: Buffer.from('png'),
  errors: [] as string[],
  height: 320,
  width: 736,
  overflow: 0,
  theme: 'dark' as const,
}
const context = (uploads: Uploads, render: ToolContext['renderHtml'] = async () => rendered) => {
  const attach = vi.fn<(block: Block) => void>()
  const showHtml = vi.fn<ToolContext['showHtml']>((block) => {
    attach(block)
    return 'created'
  })
  const value: ToolContext = {
    cwd: '/project',
    attach,
    saveImage: vi.fn(),
    processes: {} as never,
    threads: {} as never,
    delegates: {} as never,
    browser: {} as never,
    saveHtml: (html) => uploads.saveHtml(html),
    renderHtml: vi.fn(render),
    showHtml,
    saveMedia: async () => ({ id: 'x.mp4' }),
    readThread: async () => '',
    setTodos: vi.fn(),
    showStatus: vi.fn(),
    ask: vi.fn(),
    rename: vi.fn(),
  }
  return { attach, showHtml, value }
}
const uploads = async () => new Uploads(await mkdtemp(join(tmpdir(), 't3-mini-html-')))

it('saves the page privately, shows it, and returns the render check', async () => {
  const store = await uploads()
  const { attach, value } = context(store)
  const html = '<h1>Hi</h1><script>document.body.append("ok")</script>'
  const result = await runTool(showHtml, value, { html, title: 'Greeting', key: 'greeting' })
  expect(result.ok).toBe(true)
  expect(result.text).toContain('Shown to the user: Greeting.')
  expect(result.text).toContain('736×320px in the dark theme')
  expect(result.text).toContain('key "greeting"')
  expect(result.image).toEqual({
    data: Buffer.from('png').toString('base64'),
    mimeType: 'image/png',
  })
  const block = attach.mock.calls[0][0] as Extract<Block, { type: 'html' }>
  expect(block).toEqual({
    type: 'html',
    id: expect.stringMatching(/\.html$/),
    title: 'Greeting',
    key: 'greeting',
  })
  expect(await store.readHtml(block.id)).toBe(html)
  expect((await stat(join(store.directory, 'html', block.id))).mode & 0o777).toBe(0o600)
})

it('reports errors, phone overflow, and empty pages with the key to fix them', async () => {
  const { value } = context(await uploads(), async () => ({
    ...rendered,
    errors: ['ReferenceError: data is not defined'],
    overflow: 120,
  }))
  const result = await runTool(showHtml, value, { html: '<div></div>' })
  expect(result.text).toContain('- ReferenceError: data is not defined')
  expect(result.text).toContain('120px wider than the screen')
  expect(result.text).toMatch(/Fix it: call show_html again with key "page-[0-9a-f]{6}"/)
  const empty = context(await uploads(), async () => ({ ...rendered, height: 4 }))
  expect((await runTool(showHtml, empty.value, { html: '<div></div>' })).text).toContain(
    'nearly) empty',
  )
})

it('still shows the page when it can’t be checked', async () => {
  const error = Object.assign(new Error('No browser found.'), { name: 'BrowserError' })
  const { attach, value } = context(await uploads(), async () => {
    throw error
  })
  const result = await runTool(showHtml, value, { html: '<p>hi</p>', key: 'x' })
  expect(result).toMatchObject({ ok: true })
  expect(result.text).toContain('couldn’t be checked (No browser found.)')
  expect(result.image).toBeUndefined()
  expect(attach).toHaveBeenCalledOnce()
})

it('passes bundled libraries to the render and the block, and refuses unknown ones', async () => {
  const { attach, value } = context(await uploads())
  await runTool(showHtml, value, { html: '<canvas></canvas>', libraries: ['chart.js'] })
  expect(value.renderHtml).toHaveBeenCalledWith('<canvas></canvas>', ['chart.js'])
  expect(attach.mock.calls[0][0]).toMatchObject({ libraries: ['chart.js'] })
  expect(
    await runTool(showHtml, value, {
      html: '<p></p>',
      libraries: ['https://cdn.example.com/x.js'],
    }),
  ).toMatchObject({ ok: false })
  expect(await runTool(showHtml, value, { html: '<p></p>', key: '../x' })).toMatchObject({
    ok: false,
  })
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
