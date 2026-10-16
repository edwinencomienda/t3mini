import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

// t3 mini's own ports: the app, the phone-access gateway, and its Tailscale HTTPS port.
export function blockedPorts() {
  return new Set(
    [
      Number(process.env.PORT) || 4310,
      4310,
      Number(process.env.T3_MINI_PHONE_PORT) || 4311,
      Number(process.env.T3_MINI_TAILSCALE_PORT) || 8443,
    ].filter((port) => Number.isInteger(port) && port > 0),
  )
}
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])
const isLocalHost = (hostname: string) =>
  localHosts.has(hostname) || hostname.endsWith('.localhost')
const portOf = (url: URL) => Number(url.port || (url.protocol === 'https:' ? 443 : 80))

// Whether a page may be opened: an http(s) URL on this machine, and not t3 mini itself.
// Returns the reason when it isn't.
export function checkPageUrl(raw: string, ports = blockedPorts()): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'That isn’t a valid URL. Use a full address like http://localhost:5173.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return 'Only http:// and https:// pages can be opened.'
  if (!isLocalHost(url.hostname.toLowerCase()))
    return `Only local sites can be opened (localhost, 127.0.0.1, *.localhost), not ${url.hostname}.`
  if (ports.has(portOf(url))) return 'That address is t3 mini itself, which the browser can’t open.'
  return undefined
}
// Requests the page itself may make (any request to t3 mini is refused).
export function allowRequest(raw: string, ports = blockedPorts()) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
    return !(isLocalHost(url.hostname.toLowerCase()) && ports.has(portOf(url)))
  } catch {
    return true
  }
}

type LogEntry = {
  kind: 'error' | 'warning' | 'failed request' | 'dialog' | 'blocked'
  text: string
}

class Session {
  page?: Page
  // While the thread's own page is being opened (so it isn't mistaken for a popup).
  opening = false
  log: LogEntry[] = []
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

export class BrowserManager {
  private browser?: Promise<Browser>
  private sessions = new Map<string, Promise<Session>>()
  constructor(
    private readonly ports = blockedPorts(),
    private readonly executable: () => string | undefined = findBrowser,
  ) {}

  // The thread's page, opening the browser and session if needed.
  async page(threadId: string): Promise<Page> {
    const session = await this.session(threadId)
    if (!session.page || session.page.isClosed()) session.page = await this.newPage(session)
    return session.page
  }
  // The thread's page if one is open (doesn't start anything).
  async openPage(threadId: string) {
    const session = await this.sessions.get(threadId)?.catch(() => undefined)
    this.touch(threadId, session)
    return session?.page && !session.page.isClosed() ? session.page : undefined
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
    const value = await session.catch(() => undefined)
    if (value?.timer) clearTimeout(value.timer)
    await value?.context.close().catch(() => {})
    if (!this.sessions.size) await this.shutdown()
  }
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
    await this.shutdown()
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
        }),
      )
    }
    return this.browser
  }
  private async session(threadId: string) {
    let session = this.sessions.get(threadId)
    if (!session) {
      session = this.createSession()
      this.sessions.set(threadId, session)
      session.catch(() => {
        if (this.sessions.get(threadId) === session) this.sessions.delete(threadId)
      })
    }
    const value = await session
    this.touch(threadId, value)
    return value
  }
  private async createSession() {
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
    await context.route('**/*', (route, request: Request) => {
      const url = request.url()
      let mainFrame = false
      try {
        mainFrame =
          request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame()
      } catch {
        // Not tied to a page frame (e.g. a worker): only the t3 mini check applies.
      }
      const refusal = !allowRequest(url, this.ports)
        ? 't3 mini itself'
        : mainFrame && checkPageUrl(url, this.ports)
          ? 'not a local site'
          : undefined
      if (refusal) {
        session.note({ kind: 'blocked', text: `${url} (${refusal})` })
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    // Popups and new tabs aren't followed: the agent works in one page.
    context.on('page', (page) => {
      if (!session.opening) void page.close().catch(() => {})
    })
    return session
  }
  private async newPage(session: Session) {
    session.opening = true
    const page = await session.context.newPage().finally(() => (session.opening = false))
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
    // A redirect that slipped past the request check still can't keep the page elsewhere.
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || frame.url() === 'about:blank') return
      if (checkPageUrl(frame.url(), this.ports)) {
        session.note({ kind: 'blocked', text: `${frame.url()} (not a local site)` })
        void page.goto('about:blank').catch(() => {})
      }
    })
    return page
  }
}
