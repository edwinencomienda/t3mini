import { existsSync, readdirSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserInfo } from '../types'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
} from 'playwright-core'

// The agent's browser (browser_* tools): a headless Chromium-family browser already on this Mac
// (Google Chrome, Microsoft Edge, Brave, Chromium, or Playwright's own build), driven with
// Playwright. Nothing is downloaded.
//
// - One browser process, started on first use; each thread gets its own private session
//   (a fresh context: no cookies, logins, or history from your real browser, nothing saved).
// - Local sites only: localhost, 127.0.0.1, [::1], and *.localhost. Pages can still load their
//   own assets (fonts, CDNs), but the page itself can't go anywhere else, including through a
//   redirect, a link, or a popup.
// - t3 mini itself is off-limits (its own port and the phone-access ports), so an agent can never
//   open t3 mini and approve its own actions.
// - No downloads, no file uploads, no running scripts in the page, no permissions (camera,
//   location…). Dialogs (alert/confirm) are dismissed and logged.
// - A thread's session closes after 10 idle minutes, when the thread is deleted, or when t3 mini
//   stops; the browser process closes when no session is left.

const idleMs = 10 * 60_000
const navigationTimeout = 30_000
const actionTimeout = 10_000
const maxLog = 100

// Where to find a browser, in order of preference. T3_MINI_BROWSER can point at any
// Chromium-based browser's executable.
function findBrowser(): string | undefined {
  const fromEnv = process.env.T3_MINI_BROWSER
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ]
      : process.platform === 'linux'
        ? [
            '/usr/bin/google-chrome',
            '/usr/bin/microsoft-edge',
            '/usr/bin/brave-browser',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ]
        : [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
  return candidates.find((path) => existsSync(path)) ?? playwrightShell()
}
// A headless shell Playwright installed earlier (e.g. `npx playwright install`), if any.
function playwrightShell() {
  const cache =
    process.platform === 'darwin'
      ? join(homedir(), 'Library/Caches/ms-playwright')
      : join(homedir(), '.cache/ms-playwright')
  try {
    for (const folder of readdirSync(cache).sort().reverse()) {
      if (!folder.startsWith('chromium_headless_shell-')) continue
      for (const build of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64'])
        if (existsSync(join(cache, folder, build, 'chrome-headless-shell')))
          return join(cache, folder, build, 'chrome-headless-shell')
      if (existsSync(join(cache, folder, 'chrome-linux/headless_shell')))
        return join(cache, folder, 'chrome-linux/headless_shell')
    }
  } catch {
    // No cache.
  }
  return undefined
}

// This t3 mini's own ports: the app, the phone-access gateway, and its Tailscale HTTPS port. The
// dev server sets PORT=4016 (and its own phone ports); production defaults to 4011. Only this
// copy's ports: agents may open the other copy (e.g. to check the dev UI from production).
export function blockedPorts() {
  return new Set(
    [
      Number(process.env.PORT) || 4011,
      Number(process.env.T3_MINI_PHONE_PORT) || 4311,
      Number(process.env.T3_MINI_TAILSCALE_PORT) || 8443,
    ].filter((port) => Number.isInteger(port) && port > 0),
  )
}
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])
const isLocalHost = (hostname: string) =>
  localHosts.has(hostname) || hostname.endsWith('.localhost')
// Local development domains (Laravel Herd and Valet's .test, mDNS .local…): endings reserved
// for private use, so no public site can have one. Allowed only when the name resolves to
// this machine, checked when the page is opened.
const devEndings = ['.test', '.local', '.internal', '.home.arpa', '.lan']
const isDevHost = (hostname: string) => devEndings.some((ending) => hostname.endsWith(ending))
const portOf = (url: URL) => Number(url.port || (url.protocol === 'https:' ? 443 : 80))

// Whether a name resolves only to this machine (127.0.0.0/8, ::1), remembered for a minute.
export type Resolver = (hostname: string) => Promise<boolean>
const resolved = new Map<string, { at: number; local: Promise<boolean> }>()
export const resolvesToThisMachine: Resolver = (hostname) => {
  const cached = resolved.get(hostname)
  if (cached && Date.now() - cached.at < 60_000) return cached.local
  const local = lookup(hostname, { all: true })
    .then(
      (addresses) =>
        addresses.length > 0 &&
        addresses.every(
          ({ address }) =>
            address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'),
        ),
    )
    .catch(() => false)
  resolved.set(hostname, { at: Date.now(), local })
  if (resolved.size > 200) resolved.delete(resolved.keys().next().value!)
  return local
}

// Whether a page may be opened: an http(s) URL on this machine (localhost, or a local
// development domain that resolves here), and not t3 mini itself. Returns the reason when it
// isn't.
export async function checkPageUrl(
  raw: string,
  ports = blockedPorts(),
  resolve: Resolver = resolvesToThisMachine,
): Promise<string | undefined> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'That isn’t a valid URL. Use a full address like http://localhost:5173.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return (
      'Only http:// and https:// pages can be opened (not files). Serve the app with its dev ' +
      'server (start_process), then open the local address it prints.'
    )
  const hostname = url.hostname.toLowerCase()
  if (!isLocalHost(hostname)) {
    if (!isDevHost(hostname))
      return `Only local sites can be opened (localhost, 127.0.0.1, *.localhost, or a local development domain like app.test), not ${url.hostname}.`
    if (!(await resolve(hostname)))
      return `${url.hostname} doesn’t point to this Mac, so it can’t be opened.`
  }
  if (ports.has(portOf(url))) return 'That address is t3 mini itself, which the browser can’t open.'
  return undefined
}
// Requests the page itself may make (any request to t3 mini is refused, including through a
// local development domain).
export function allowRequest(raw: string, ports = blockedPorts()) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
    const hostname = url.hostname.toLowerCase()
    return !((isLocalHost(hostname) || isDevHost(hostname)) && ports.has(portOf(url)))
  } catch {
    return true
  }
}

type LogEntry = {
  kind: 'error' | 'warning' | 'failed request' | 'dialog' | 'blocked' | 'popup'
  text: string
}

// A thread's tabs: ones the agent opened, and popups pages opened (window.open, target=_blank).
// One is active; the tools act on it. Tabs share the thread's cookies, like one browser window.
type Tab = { id: string; page: Page; popup: boolean }
export type TabInfo = { id: string; url: string; title: string; active: boolean }
const maxTabs = 5

class Session {
  tabs: Tab[] = []
  active?: string
  // Tabs in the order they were last active, so closing one returns to the one before.
  history: string[] = []
  next = 1
  // While the agent's own tab is being opened (so it isn't mistaken for a popup).
  opening = false
  log: LogEntry[] = []
  activeTab() {
    return this.tabs.find((tab) => tab.id === this.active && !tab.page.isClosed())
  }
  activate(id: string) {
    this.active = id
    this.history = [...this.history.filter((item) => item !== id), id]
  }
  timer?: NodeJS.Timeout
  constructor(readonly context: BrowserContext) {}
  note(entry: LogEntry) {
    this.log.push({ ...entry, text: entry.text.slice(0, 500) })
    if (this.log.length > maxLog) this.log.splice(0, this.log.length - maxLog)
  }
}

export class BrowserError extends Error {
  readonly name = 'BrowserError'
}

// "button 'Save'" from an AI snapshot line like `- button "Save" [ref=e12]`, for each ref.
export function snapshotRefs(snapshot: string) {
  const refs = new Map<string, string>()
  for (const line of snapshot.split('\n')) {
    const match = /^\s*-\s*([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*?\[ref=(e\d+)\]/.exec(line)
    if (!match) continue
    const [, role, name, ref] = match
    const text = (name ?? '').replace(/\\"/g, '"').trim()
    refs.set(ref!, text ? `${role === 'generic' ? '' : `${role} `}'${text.slice(0, 60)}'` : role!)
  }
  return refs
}

export class BrowserManager {
  private browser?: Promise<Browser>
  private sessions = new Map<string, Promise<Session>>()
  // Each thread's open page (for the composer's browser chip) and its snapshot refs.
  private info = new Map<string, BrowserInfo>()
  private refs = new Map<string, Map<string, string>>()
  private listeners = new Set<() => void>()
  constructor(
    private readonly ports = blockedPorts(),
    private readonly executable: () => string | undefined = findBrowser,
    private readonly resolve: Resolver = resolvesToThisMachine,
  ) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  private changed() {
    this.listeners.forEach((listener) => listener())
  }
  // Threads with an open page.
  list(): BrowserInfo[] {
    return [...this.info.values()]
  }
  recordSnapshot(threadId: string, snapshot: string) {
    this.refs.set(threadId, snapshotRefs(snapshot))
  }
  refName(threadId: string, ref: string) {
    const id = /^\[?(?:ref=)?(e\d+)\]?$/i.exec(ref.trim())?.[1]
    return id ? this.refs.get(threadId)?.get(id) : undefined
  }
  // A small, fresh picture of the thread's page for the browser chip, if one is open.
  async preview(threadId: string) {
    const page = await this.openPage(threadId)
    if (!page) return undefined
    return page.screenshot({ type: 'jpeg', quality: 70, animations: 'disabled', timeout: 5000 })
  }

  // The thread's active tab, opening the browser and a first tab if needed.
  async page(threadId: string): Promise<Page> {
    const session = await this.session(threadId)
    return session.activeTab()?.page ?? (await this.newPage(session, threadId))
  }
  // The thread's active tab if one is open (doesn't start anything).
  async openPage(threadId: string) {
    const session = await this.sessions.get(threadId)?.catch(() => undefined)
    this.touch(threadId, session)
    return session?.activeTab()?.page
  }
  // Opens another tab (made active), up to the limit.
  async newTab(threadId: string) {
    const session = await this.session(threadId)
    if (session.tabs.length >= maxTabs)
      throw new BrowserError(`At most ${maxTabs} tabs are open at once. Close one first.`)
    return this.newPage(session, threadId)
  }
  async tabs(threadId: string): Promise<TabInfo[]> {
    const session = await this.sessions.get(threadId)?.catch(() => undefined)
    this.touch(threadId, session)
    return Promise.all(
      (session?.tabs ?? []).map(async (tab) => ({
        id: tab.id,
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ''),
        active: tab.id === session!.active,
      })),
    )
  }
  async switchTab(threadId: string, id: string) {
    const session = await this.sessions.get(threadId)?.catch(() => undefined)
    const tab = session?.tabs.find((item) => item.id === id)
    if (!session || !tab) throw new BrowserError(`There's no tab ${id}. List tabs to see them.`)
    this.touch(threadId, session)
    session.activate(id)
    await tab.page.bringToFront().catch(() => {})
    this.refs.delete(threadId)
    this.updateInfo(threadId, session)
    return tab.page
  }
  async closeTab(threadId: string, id: string) {
    const session = await this.sessions.get(threadId)?.catch(() => undefined)
    const tab = session?.tabs.find((item) => item.id === id)
    if (!tab) throw new BrowserError(`There's no tab ${id}. List tabs to see them.`)
    await tab.page.close().catch(() => {})
  }
  // Errors, failed requests, and dialogs since the page was opened (and clears them).
  async takeLog(threadId: string) {
    const session = await this.sessions.get(threadId)?.catch(() => undefined)
    const log = session?.log ?? []
    if (session) session.log = []
    return log
  }
  async close(threadId: string) {
    const session = this.sessions.get(threadId)
    if (!session) return
    this.sessions.delete(threadId)
    this.forget(threadId)
    const value = await session.catch(() => undefined)
    if (value?.timer) clearTimeout(value.timer)
    await value?.context.close().catch(() => {})
    if (!this.sessions.size) await this.shutdown()
  }
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
    await this.shutdown()
  }

  private forget(threadId: string) {
    this.refs.delete(threadId)
    if (this.info.delete(threadId)) this.changed()
  }
  private async shutdown() {
    const browser = this.browser
    this.browser = undefined
    await (await browser?.catch(() => undefined))?.close().catch(() => {})
  }
  private touch(threadId: string, session?: Session) {
    if (!session) return
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => void this.close(threadId), idleMs)
    session.timer.unref?.()
  }
  private launch() {
    if (!this.browser) {
      const executablePath = this.executable()
      if (!executablePath)
        return Promise.reject(
          new BrowserError(
            'No browser found. Install Google Chrome (or Microsoft Edge, Brave, or Chromium), or set T3_MINI_BROWSER to a Chromium-based browser.',
          ),
        )
      this.browser = chromium.launch({ executablePath, headless: true }).catch((error) => {
        this.browser = undefined
        throw new BrowserError(
          `The browser couldn’t start: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`,
        )
      })
      void this.browser.then((browser) =>
        browser.on('disconnected', () => {
          this.browser = undefined
          this.sessions.clear()
          this.refs.clear()
          if (this.info.size) {
            this.info.clear()
            this.changed()
          }
        }),
      )
    }
    return this.browser
  }
  private async session(threadId: string) {
    let session = this.sessions.get(threadId)
    if (!session) {
      session = this.createSession(threadId)
      this.sessions.set(threadId, session)
      session.catch(() => {
        if (this.sessions.get(threadId) === session) this.sessions.delete(threadId)
      })
    }
    const value = await session
    this.touch(threadId, value)
    return value
  }
  private async createSession(threadId: string) {
    const browser = await this.launch()
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
    })
    context.setDefaultTimeout(actionTimeout)
    context.setDefaultNavigationTimeout(navigationTimeout)
    const session = new Session(context)
    // Every request goes through here: nothing may reach t3 mini, and the page itself (its
    // top-level document) stays on local sites.
    await context.route('**/*', async (route, request: Request) => {
      const url = request.url()
      let mainFrame = false
      let from: Page | undefined
      try {
        from = request.frame().page()
        mainFrame = request.isNavigationRequest() && request.frame() === from.mainFrame()
      } catch {
        // No frame yet: a popup's first navigation is issued before its page exists, and it's
        // a top-level page load like any other, so the local-sites rule applies. (Other
        // frameless requests, from workers, only get the t3 mini check.)
        mainFrame = request.isNavigationRequest()
      }
      const refusal = !allowRequest(url, this.ports)
        ? 't3 mini itself'
        : mainFrame && (await checkPageUrl(url, this.ports, this.resolve))
          ? 'not a local site'
          : undefined
      if (refusal) {
        session.note({ kind: 'blocked', text: `${url} (${refusal})` })
        // A popup headed somewhere it can't go (e.g. a sign-in site) is closed.
        if (mainFrame) {
          const tab = session.tabs.find((item) => item.page === from)
          if (tab?.popup && tab.page.url() === 'about:blank') void tab.page.close().catch(() => {})
        }
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    // Popups (window.open, target=_blank links) open as tabs and become active, so the agent
    // can follow them; past the tab limit they're closed.
    context.on('page', (page) => {
      if (session.opening) return
      if (session.tabs.length >= maxTabs) {
        session.note({
          kind: 'blocked',
          text: `A popup was closed: ${maxTabs} tabs are already open.`,
        })
        void page.close().catch(() => {})
        return
      }
      this.wire(session, threadId, page, true)
    })
    return session
  }
  private async newPage(session: Session, threadId: string) {
    session.opening = true
    const page = await session.context.newPage().finally(() => (session.opening = false))
    return this.wire(session, threadId, page, false)
  }
  // What the browser chip shows: the active tab's address and title, and how many are open.
  private updateInfo(threadId: string, session: Session) {
    const tab = session.activeTab()
    if (!tab) return this.forget(threadId)
    const url = tab.page.url()
    if (url === 'about:blank') return
    void tab.page
      .title()
      .catch(() => '')
      .then((title) => {
        const next = { threadId, url, title, tabs: session.tabs.length }
        const current = this.info.get(threadId)
        if (current?.url === next.url && current.title === next.title && current.tabs === next.tabs)
          return
        this.info.set(threadId, next)
        this.changed()
      })
  }
  // Registers a tab (the agent's or a popup), makes it active, and watches it.
  private wire(session: Session, threadId: string, page: Page, popup: boolean) {
    const tab: Tab = { id: `t${session.next++}`, page, popup }
    session.tabs.push(tab)
    session.activate(tab.id)
    if (popup) {
      session.note({ kind: 'popup', text: `Tab ${tab.id} opened (a popup) and is now active.` })
      // Backstop: a popup already showing somewhere it can't be is closed right away.
      const url = page.url()
      if (url !== 'about:blank')
        void checkPageUrl(url, this.ports, this.resolve).then((refusal) => {
          if (!refusal) return
          session.note({ kind: 'blocked', text: `${url} (not a local site)` })
          void page.close().catch(() => {})
        })
    }
    page.on('console', (message: ConsoleMessage) => {
      const type = message.type()
      if (type === 'error' || type === 'warning')
        session.note({ kind: type === 'error' ? 'error' : 'warning', text: message.text() })
    })
    page.on('pageerror', (error) => session.note({ kind: 'error', text: error.message }))
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'failed'
      if (reason.includes('BLOCKED_BY_CLIENT')) return
      session.note({
        kind: 'failed request',
        text: `${request.method()} ${request.url()} (${reason})`,
      })
    })
    page.on('response', (response) => {
      if (response.status() >= 400)
        session.note({
          kind: 'failed request',
          text: `${response.request().method()} ${response.url()} (${response.status()})`,
        })
    })
    page.on('dialog', (dialog) => {
      session.note({ kind: 'dialog', text: `${dialog.type()}: ${dialog.message()}` })
      void dialog.dismiss().catch(() => {})
    })
    const update = () => {
      if (session.active === tab.id) this.updateInfo(threadId, session)
    }
    page.on('load', update)
    page.on('domcontentloaded', update)
    // A closed tab leaves; the last remaining one becomes active.
    page.on('close', () => {
      session.tabs = session.tabs.filter((item) => item !== tab)
      session.history = session.history.filter((item) => item !== tab.id)
      if (session.active === tab.id) {
        session.active = session.history.at(-1) ?? session.tabs.at(-1)?.id
        this.refs.delete(threadId)
      }
      this.updateInfo(threadId, session)
    })
    // A redirect that slipped past the request check still can't keep the page elsewhere.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) update()
      if (frame !== page.mainFrame() || frame.url() === 'about:blank') return
      const url = frame.url()
      void checkPageUrl(url, this.ports, this.resolve).then((refusal) => {
        if (!refusal || page.isClosed() || page.url() !== url) return
        session.note({ kind: 'blocked', text: `${url} (not a local site)` })
        if (tab.popup) void page.close().catch(() => {})
        else void page.goto('about:blank').catch(() => {})
      })
    })
    update()
    return page
  }
}
