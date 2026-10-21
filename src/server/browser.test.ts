import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BrowserManager, allowRequest, checkPageUrl, snapshotRefs } from './browser'
import {
  browserCheck,
  browserClick,
  browserConsole,
  browserOpen,
  browserScreenshot,
  browserSetCookie,
  browserSnapshot,
  browserTabs,
  browserType,
  browserWaitFor,
} from './tools/browser'
import { maskInput, runTool } from './tools'
import { describeClaudeTool } from './providers/activity'
import type { ToolContext } from './tools/types'

const t3 = new Set([4310, 4311])

describe('where the agent’s browser may go', () => {
  it('opens local sites only, never t3 mini itself', async () => {
    const neverResolves = async () => false
    for (const url of [
      'http://localhost:5173/',
      'https://localhost:3000/login',
      'http://127.0.0.1:8080',
      'http://[::1]:5173',
      'http://myapp.localhost:5173',
      'http://0.0.0.0:3000',
    ])
      expect(await checkPageUrl(url, t3, neverResolves), url).toBeUndefined()
    expect(await checkPageUrl('https://example.com', t3)).toMatch(/Only local sites/)
    expect(await checkPageUrl('http://localhost.example.com', t3)).toMatch(/Only local sites/)
    expect(await checkPageUrl('http://192.168.1.10:5173', t3)).toMatch(/Only local sites/)
    expect(await checkPageUrl('file:///etc/passwd', t3)).toMatch(/http/)
    expect(await checkPageUrl('javascript:alert(1)', t3)).toMatch(/http/)
    expect(await checkPageUrl('not a url', t3)).toMatch(/valid URL/)
    expect(await checkPageUrl('http://localhost:4310/', t3)).toMatch(/t3 mini itself/)
    expect(await checkPageUrl('http://127.0.0.1:4311/pair', t3)).toMatch(/t3 mini itself/)
  })
  it('opens local development domains (app.test…) only when they point to this machine', async () => {
    const here = async (host: string) => host === 'myapp.test' || host === 'printer.local'
    expect(await checkPageUrl('http://myapp.test/dashboard', t3, here)).toBeUndefined()
    expect(await checkPageUrl('https://printer.local', t3, here)).toBeUndefined()
    expect(await checkPageUrl('http://elsewhere.test', t3, here)).toMatch(
      /doesn’t point to this Mac/,
    )
    // A public domain is refused even if it resolves here; only reserved endings count.
    expect(await checkPageUrl('http://rebind.example.com', t3, async () => true)).toMatch(
      /Only local sites/,
    )
    expect(await checkPageUrl('http://myapp.test:4310', t3, here)).toMatch(/t3 mini itself/)
    expect(allowRequest('http://myapp.test:4310/api/threads', t3)).toBe(false)
  })
  it('lets pages load assets anywhere except t3 mini', () => {
    expect(allowRequest('https://fonts.googleapis.com/css', t3)).toBe(true)
    expect(allowRequest('http://localhost:5173/app.js', t3)).toBe(true)
    expect(allowRequest('http://localhost:4310/api/threads', t3)).toBe(false)
    expect(allowRequest('http://127.0.0.1:4311/', t3)).toBe(false)
    expect(allowRequest('http://app.localhost:4310/', t3)).toBe(false)
  })
})

describe('readable names for snapshot refs', () => {
  it('names each ref by its role and label', () => {
    const refs = snapshotRefs(
      [
        '- heading "Hello" [level=1] [ref=e2]',
        '- textbox "Name" [ref=e5]',
        '- button "Say \\"hi\\"" [ref=e6]',
        '- generic "Card" [ref=e7]',
        '- list [ref=e8]',
        '- text: no ref here',
      ].join('\n'),
    )
    expect(Object.fromEntries(refs)).toEqual({
      e2: "heading 'Hello'",
      e5: "textbox 'Name'",
      e6: `button 'Say "hi"'`,
      e7: "'Card'",
      e8: 'list',
    })
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
      if (request.url === '/account') {
        // Signed in when the test session cookie is there.
        const signedIn = /(?:^|; )session=test-token(?:;|$)/.test(request.headers.cookie ?? '')
        response.setHeader('content-type', 'text/html')
        return response.end(
          `<!doctype html><title>Account</title><h1>${signedIn ? 'Welcome back, Ada' : 'Please sign in'}</h1>`,
        )
      }
      if (request.url === '/popups') {
        response.setHeader('content-type', 'text/html')
        return response.end(`<!doctype html><title>Popups</title>
          <button onclick="window.open('/account')">Open account</button>
          <a href="/slow" target="_blank">New tab link</a>
          <button onclick="window.open('https://example.com/oauth')">Sign in elsewhere</button>`)
      }
      if (request.url === '/slow') {
        response.setHeader('content-type', 'text/html')
        return response.end(`<!doctype html><title>Slow</title><p id="status">Loading…</p>
          <script>setTimeout(() => { document.querySelector('#status').textContent = 'Ready!'; history.pushState({}, '', '/slow/done') }, 1200)</script>`)
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
    saveHtml: async () => ({ id: 'x.html' }),
    saveMedia: async () => ({ id: 'x.mp4' }),
    readThread: async () => '',
    processes: {} as never,
    threads: {} as never,
    rename: vi.fn(),
    browser: {
      page: () => browsers.page(thread),
      openPage: () => browsers.openPage(thread),
      takeLog: () => browsers.takeLog(thread),
      close: () => browsers.close(thread),
      newTab: () => browsers.newTab(thread),
      tabs: () => browsers.tabs(thread),
      switchTab: (id) => browsers.switchTab(thread, id),
      closeTab: (id) => browsers.closeTab(thread, id),
      recordSnapshot: (snapshot) => browsers.recordSnapshot(thread, snapshot),
      refName: (ref) => browsers.refName(thread, ref),
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
    // Steps can name what they act on, and the chip knows the open page.
    expect(browsers.refName('thread-1', field!)).toBe("textbox 'Name'")
    expect(browsers.list()).toContainEqual({
      threadId: 'thread-1',
      url: `${base}/`,
      title: 'Demo app',
      tabs: 1,
    })
    const preview = await browsers.preview('thread-1')
    expect(preview?.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
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
    // Problems show up in the page health of the call that opened the page, and anything that
    // happens later in browser_console (each only once).
    const opened = await runTool(browserOpen, tools, { url: `${base}/` })
    expect(opened.text).toMatch(/Page health: /)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const log = { text: opened.text + (await runTool(browserConsole, tools, {})).text }
    expect(log.text).toContain('boom from the page')
    expect(log.text).toMatch(/\/missing \(404\)/)
    expect(log.text).toMatch(/\[blocked\].*api\/approve/)
    expect(blockedHits).toBe(0)
    expect((await runTool(browserConsole, tools, {})).text).toMatch(/Nothing new/)
  }, 30_000)

  it('checks a page in one step, and opens the running dev server without a URL', async () => {
    // No dev server running: a clear message, nothing opened.
    const idle = { ...context('thread-8'), processes: { list: () => [] } as never }
    expect(await runTool(browserCheck, idle, {})).toMatchObject({
      ok: false,
      text: expect.stringContaining('No running dev server'),
    })
    // The project's dev server printed this address; check opens it at phone size.
    const running = {
      ...context('thread-8'),
      processes: {
        list: () => [
          { status: 'running', url: `${base}/`, startedAt: '2026-01-01T00:00:00.000Z' },
          { status: 'exited', url: 'http://localhost:1/', startedAt: '2026-02-01T00:00:00.000Z' },
        ],
      } as never,
    }
    const checked = await runTool(browserCheck, running, { size: 'phone' })
    expect(checked.ok).toBe(true)
    expect(checked.image?.mimeType).toBe('image/png')
    expect(Buffer.from(checked.image!.data, 'base64').readUInt32BE(16)).toBe(390)
    expect(checked.text).toContain('Demo app')
    expect(checked.text).toContain(`(${base}/)`)
    expect(checked.text).toMatch(/Page health: /)
    // browser_open without a URL does the same, and needs no approval (only loads a page).
    const opened = await runTool(browserOpen, running, {})
    expect(opened.text).toContain(`(${base}/)`)
    expect(browserOpen.safety).toBe('safe')
    expect(browserCheck.safety).toBe('safe')
    expect(browserClick.safety).toBe('approval')
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

  it('waits for text, an element, or an address instead of guessing', async () => {
    const tools = context('thread-4')
    await runTool(browserOpen, tools, { url: `${base}/slow` })
    const ready = await runTool(browserWaitFor, tools, { text: 'Ready!', url: '/slow/done' })
    expect(ready.ok).toBe(true)
    expect(ready.text).toContain('Ready!')
    const timedOut = await runTool(browserWaitFor, tools, { text: 'Never shown', seconds: 1 })
    expect(timedOut).toMatchObject({ ok: false })
    expect(timedOut.text).toMatch(/Waiting failed/)
    expect((await runTool(browserWaitFor, tools, {})).text).toMatch(/Say what to wait for/)
  }, 30_000)

  it('signs in with a cookie on local sites only, and never shows its value', async () => {
    const tools = context('thread-5')
    expect((await runTool(browserOpen, tools, { url: `${base}/account` })).text).toContain(
      'Please sign in',
    )
    const set = await runTool(browserSetCookie, tools, {
      url: base,
      name: 'session',
      value: 'test-token',
      httpOnly: true,
    })
    expect(set.ok).toBe(true)
    expect(set.text).not.toContain('test-token')
    expect((await runTool(browserOpen, tools, { url: `${base}/account` })).text).toContain(
      'Welcome back, Ada',
    )
    const outside = await runTool(browserSetCookie, tools, {
      url: 'https://example.com',
      name: 'session',
      value: 'x',
    })
    expect(outside.text).toMatch(/Only local sites/)
    expect(
      (await runTool(browserSetCookie, tools, { url: base, name: 'a b', value: 'x' })).text,
    ).toMatch(/valid cookie name/)
    // The work log and approval prompts hide the value.
    const step = describeClaudeTool(
      'mcp__t3mini__browser_set_cookie',
      { url: base, name: 'session', value: 'test-token' },
      '/tmp',
    )
    expect(step.detail).not.toContain('test-token')
    expect(step.summary).toContain('session')
    expect(maskInput(browserSetCookie, { name: 'session', value: 'test-token' })).toEqual({
      name: 'session',
      value: '••••••',
    })
  }, 30_000)

  it('screenshots a single element', async () => {
    const tools = context('thread-6')
    await runTool(browserOpen, tools, { url: `${base}/` })
    const whole = await runTool(browserScreenshot, tools, {})
    const button = await runTool(browserScreenshot, tools, { target: 'role=button[name="Greet"]' })
    expect(button.ok).toBe(true)
    const width = (png: string) => Buffer.from(png, 'base64').readUInt32BE(16)
    expect(width(button.image!.data)).toBeLessThan(width(whole.image!.data) / 4)
  }, 30_000)

  it('opens popups as tabs, switches and closes them, and closes popups that leave', async () => {
    const tools = context('thread-7')
    await runTool(browserOpen, tools, { url: `${base}/popups` })
    // window.open becomes a new, active tab.
    const popup = await runTool(browserClick, tools, { target: 'role=button[name="Open account"]' })
    expect(popup.text).toMatch(/A new tab opened \(t2\) and is now active/)
    expect(popup.text).toContain('Tab t2 of 2')
    expect(popup.text).toContain('Please sign in')
    // So does a target=_blank link, and tabs share cookies.
    await runTool(browserTabs, tools, { action: 'switch', tab: 't1' })
    const link = await runTool(browserClick, tools, { target: 'text=New tab link' })
    expect(link.text).toMatch(/A new tab opened \(t3\)/)
    // A popup headed to an outside site is closed; the page stays.
    await runTool(browserTabs, tools, { action: 'switch', tab: 't1' })
    const away = await runTool(browserClick, tools, {
      target: 'role=button[name="Sign in elsewhere"]',
    })
    expect(away.text).not.toMatch(/A new tab opened/)
    // Reported with the click (page health), or by browser_console if it came later.
    expect(away.text + (await runTool(browserConsole, tools, {})).text).toMatch(
      /\[blocked\].*example\.com/,
    )
    // List, close, and the chip's count.
    let list = await runTool(browserTabs, tools, { action: 'list' })
    expect(list.text).toMatch(/t1 \(active\): Popups/)
    expect(list.text).toMatch(/t2: Account/)
    expect(list.text).toMatch(/t3: Slow/)
    expect(browsers.list().find((item) => item.threadId === 'thread-7')?.tabs).toBe(3)
    list = await runTool(browserTabs, tools, { action: 'close', tab: 't2' })
    expect(list.text).not.toMatch(/t2:/)
    expect((await runTool(browserTabs, tools, { action: 'switch', tab: 't9' })).text).toMatch(
      /no tab t9/,
    )
    // A new tab on request, up to the limit.
    const opened = await runTool(browserOpen, tools, { url: `${base}/`, newTab: true })
    expect(opened.text).toMatch(/Tab t\d+ of 3/)
    await runTool(browserOpen, tools, { url: `${base}/`, newTab: true })
    await runTool(browserOpen, tools, { url: `${base}/`, newTab: true })
    const tooMany = await runTool(browserOpen, tools, { url: `${base}/`, newTab: true })
    expect(tooMany.text).toMatch(/At most 5 tabs/)
  }, 45_000)

  it('keeps each thread’s session private and closes it', async () => {
    const one = await browsers.page('private-1')
    const two = await browsers.page('private-2')
    expect(one.context()).not.toBe(two.context())
    await browsers.close('private-1')
    expect(one.isClosed()).toBe(true)
    expect(browsers.list().some((item) => item.threadId === 'private-1')).toBe(false)
    expect(await browsers.openPage('private-1')).toBeUndefined()
  }, 30_000)
})
