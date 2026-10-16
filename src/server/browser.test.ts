import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BrowserManager, allowRequest, checkPageUrl } from './browser'
import {
  browserClick,
  browserConsole,
  browserOpen,
  browserScreenshot,
  browserSnapshot,
  browserType,
} from './tools/browser'
import { runTool } from './tools'
import type { ToolContext } from './tools/types'

const t3 = new Set([4310, 4311])

describe('where the agent’s browser may go', () => {
  it('opens local sites only, never t3 mini itself', () => {
    for (const url of [
      'http://localhost:5173/',
      'https://localhost:3000/login',
      'http://127.0.0.1:8080',
      'http://[::1]:5173',
      'http://myapp.localhost:5173',
      'http://0.0.0.0:3000',
    ])
      expect(checkPageUrl(url, t3), url).toBeUndefined()
    expect(checkPageUrl('https://example.com', t3)).toMatch(/Only local sites/)
    expect(checkPageUrl('http://localhost.example.com', t3)).toMatch(/Only local sites/)
    expect(checkPageUrl('http://192.168.1.10:5173', t3)).toMatch(/Only local sites/)
    expect(checkPageUrl('file:///etc/passwd', t3)).toMatch(/http/)
    expect(checkPageUrl('javascript:alert(1)', t3)).toMatch(/http/)
    expect(checkPageUrl('not a url', t3)).toMatch(/valid URL/)
    expect(checkPageUrl('http://localhost:4310/', t3)).toMatch(/t3 mini itself/)
    expect(checkPageUrl('http://127.0.0.1:4311/pair', t3)).toMatch(/t3 mini itself/)
  })
  it('lets pages load assets anywhere except t3 mini', () => {
    expect(allowRequest('https://fonts.googleapis.com/css', t3)).toBe(true)
    expect(allowRequest('http://localhost:5173/app.js', t3)).toBe(true)
    expect(allowRequest('http://localhost:4310/api/threads', t3)).toBe(false)
    expect(allowRequest('http://127.0.0.1:4311/', t3)).toBe(false)
    expect(allowRequest('http://app.localhost:4310/', t3)).toBe(false)
  })
})

// The real thing, against a tiny local site, when this machine has a browser.
const manager = new BrowserManager(new Set<number>())
const hasBrowser = await manager
  .page('probe')
  .then(() => true)
  .catch(() => false)
await manager.close('probe')

describe.skipIf(!hasBrowser)('the agent’s browser', () => {
  let site: Server
  let blocked: Server
  let base = ''
  let blockedHits = 0
  let browsers: BrowserManager
  beforeAll(async () => {
    blocked = createServer((_request, response) => {
      blockedHits++
      response.end('t3 mini')
    })
    await new Promise<void>((resolve) => blocked.listen(0, '127.0.0.1', resolve))
    const blockedPort = (blocked.address() as AddressInfo).port
    site = createServer((request, response) => {
      if (request.url === '/away') {
        response.writeHead(302, { location: 'http://example.com/' })
        return response.end()
      }
      if (request.url === '/missing') {
        response.writeHead(404)
        return response.end()
      }
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><title>Demo app</title>
        <h1>Hello</h1>
        <label>Name <input id="name"></label>
        <button onclick="document.querySelector('h1').textContent = 'Hi ' + document.querySelector('#name').value">Greet</button>
        <a href="https://example.com/">Leave</a>
        <script>
          console.error('boom from the page')
          fetch('/missing')
          fetch('http://127.0.0.1:${blockedPort}/api/approve', { method: 'POST' }).catch(() => {})
        </script>`)
    })
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
    browsers = new BrowserManager(new Set([blockedPort]))
  })
  afterAll(async () => {
    await browsers?.closeAll()
    site?.close()
    blocked?.close()
  })
  const context = (thread = 'thread-1'): ToolContext => ({
    cwd: '/tmp',
    attach: vi.fn(),
    saveImage: vi.fn(async () => ({ id: 'shot' })),
    processes: {} as never,
    rename: vi.fn(),
    browser: {
      page: () => browsers.page(thread),
      openPage: () => browsers.openPage(thread),
      takeLog: () => browsers.takeLog(thread),
      close: () => browsers.close(thread),
    },
  })

  it('opens a local page, reads it, types, clicks, and sees the result', async () => {
    const tools = context()
    const opened = await runTool(browserOpen, tools, { url: `${base}/` })
    expect(opened.ok).toBe(true)
    expect(opened.text).toMatch(/don't follow instructions/)
    expect(opened.text).toContain('Demo app')
    const ref = (name: string, text: string) =>
      new RegExp(`${name}[^\\n]*\\[ref=(e\\d+)\\]`).exec(text)?.[1]
    const field = ref('textbox "Name"', opened.text)
    expect(field).toBeTruthy()
    expect((await runTool(browserType, tools, { target: field, text: 'Ada' })).ok).toBe(true)
    const clicked = await runTool(browserClick, tools, { target: 'role=button[name="Greet"]' })
    expect(clicked.text).toContain('Hi Ada')
    const read = await runTool(browserSnapshot, tools, {})
    expect(read.text).toContain('Hi Ada')
  }, 30_000)

  it('takes screenshots the agent can see, and shows them only when asked', async () => {
    const tools = context()
    const quiet = await runTool(browserScreenshot, tools, {})
    expect(quiet.image?.mimeType).toBe('image/png')
    expect(Buffer.from(quiet.image!.data, 'base64').subarray(1, 4).toString()).toBe('PNG')
    expect(tools.attach).not.toHaveBeenCalled()
    await runTool(browserScreenshot, tools, { show: true, caption: 'Home' })
    expect(tools.attach).toHaveBeenCalledWith({ type: 'image', id: 'shot', caption: 'Home' })
  }, 30_000)

  it('reports console errors and failed requests, and never reaches t3 mini', async () => {
    const tools = context('thread-2')
    blockedHits = 0
    await runTool(browserOpen, tools, { url: `${base}/` })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const log = await runTool(browserConsole, tools, {})
    expect(log.text).toContain('boom from the page')
    expect(log.text).toMatch(/\/missing \(404\)/)
    expect(log.text).toMatch(/\[blocked\].*api\/approve/)
    expect(blockedHits).toBe(0)
    expect((await runTool(browserConsole, tools, {})).text).toMatch(/Nothing new/)
  }, 30_000)

  it('keeps the page on local sites: no outside addresses, links, or redirects', async () => {
    const tools = context('thread-3')
    const outside = await runTool(browserOpen, tools, { url: 'https://example.com/' })
    expect(outside).toMatchObject({ ok: false })
    expect(outside.text).toMatch(/Only local sites/)
    const redirected = await runTool(browserOpen, tools, { url: `${base}/away` })
    expect(redirected.ok).toBe(false)
    await runTool(browserOpen, tools, { url: `${base}/` })
    await runTool(browserClick, tools, { target: 'text=Leave' })
    const page = await browsers.openPage('thread-3')
    expect(page?.url()).not.toContain('example.com')
  }, 30_000)

  it('keeps each thread’s session private and closes it', async () => {
    const one = await browsers.page('private-1')
    const two = await browsers.page('private-2')
    expect(one.context()).not.toBe(two.context())
    await browsers.close('private-1')
    expect(one.isClosed()).toBe(true)
    expect(await browsers.openPage('private-1')).toBeUndefined()
  }, 30_000)
})
