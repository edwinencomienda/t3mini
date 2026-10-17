# Agent browser (developer guide)

Agents can open the app they're working on in a real browser, read and use the page, check the console, and take screenshots, so they can check their own work instead of coding blind. It works for Claude and Codex through the [tool system](tools.md).

Status: stage 1. Tools only; there's no live browser panel yet.

## Pieces

```text
src/server/browser.ts        BrowserManager: finds and launches the browser, one private session per thread,
                             the address rules (checkPageUrl, allowRequest), console/network log, idle close
src/server/tools/browser.ts  the browser_* tools
src/server/tools/types.ts    ToolContext.browser (the thread's session) and ToolResult (text + optional image)
```

- **Browser:** `playwright-core` (pinned) drives a Chromium-family browser that's already installed. In order: `T3_MINI_BROWSER` (path to any Chromium-based browser), Google Chrome, Microsoft Edge, Brave, Chromium, then a Playwright headless shell in the Playwright cache. Nothing is downloaded. Without any of them, the tools say so.
- **Sessions:** one headless browser process, started on first use. Each thread gets its own context (no cookies, storage, or logins; nothing saved) with up to 5 tabs; the tools act on the active one. A session closes after 10 idle minutes, when its thread or project is deleted, or when t3 mini stops (`service.close()`); the browser process closes when the last session does.
- **Images back to the agent:** a tool may return `{ text, image }`. Claude gets an MCP `image` content item, Codex an `inputImage` data URL. Showing an image in the chat stays separate (`attach()`), so screenshots appear only when the agent passes `show: true`.

## Tools

| Tool                                             | Does                                                                                                                                                          | Safety   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `browser_open`                                   | Open a local URL (in the active tab, or `newTab: true`); returns an accessibility snapshot                                                                    | approval |
| `browser_tabs`                                   | List tabs, switch the active one, or close one                                                                                                                | safe     |
| `browser_snapshot`                               | Read the page (`page.ariaSnapshot({ mode: 'ai' })`, refs like `e12`)                                                                                          | safe     |
| `browser_click`, `browser_type`, `browser_press` | Use the page, by ref (`e12`) or Playwright selector                                                                                                           | approval |
| `browser_scroll`                                 | Scroll, or bring an element into view                                                                                                                         | safe     |
| `browser_screenshot`                             | PNG for the agent, of the page or one element (`target`); `show: true` also puts it in the chat                                                               | safe     |
| `browser_wait_for`                               | Wait for text or an element to appear (or `gone`), or the address to contain something; up to 30 s                                                            | safe     |
| `browser_set_cookie`                             | Set a cookie on a local site (e.g. a test user's session to test signed in); the value is a `secretInputs` field, hidden in the work log and approval prompts | approval |
| `browser_console`                                | Console errors/warnings, page errors, failed and 4xx/5xx requests, dialogs, blocked addresses (since the last look)                                           | safe     |
| `browser_resize`, `browser_theme`                | Phone/tablet/desktop size; light/dark                                                                                                                         | safe     |
| `browser_close`                                  | Close the session                                                                                                                                             | safe     |

`approval` tools go through Allow once / Decline unless the thread runs with full access, like the process tools.

## What you see

- **Steps:** browser tools are marked `kind: 'browser'`, so their work-log steps (and the live line) show a globe. Click, type, and scroll name their element from the latest snapshot ("Click button 'Save'"): each snapshot's refs are recorded per thread (`snapshotRefs()`), and step summaries get a `refName` hint while the call is described.
- **Live line:** a running browser step adds the page's site ("· localhost:5173").
- **Browser chip:** the live snapshot carries `browsers` (thread, URL, title of each open page, updated on navigation and load). The composer shows a chip for the open thread; its popover has the title and URL, a preview from `GET /api/threads/:id/browser/preview` (a fresh JPEG, polled every 3 s while open), and Close browser (`POST /api/threads/:id/browser/close`). Both endpoints sit behind the usual same-origin checks and only act on that thread's session.

## Safety rules

- **Local sites only.** The page itself (its top-level document) may only be `http(s)` on `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, or `*.localhost`, or on a local development domain (`.test`, `.local`, `.internal`, `.home.arpa`, `.lan`; e.g. Laravel Herd's `app.test`) that resolves only to this machine (127.0.0.0/8 or ::1; looked up when opening, cached a minute). Those endings are reserved for private use, so no public site can have one, and a public name that happens to resolve here is still refused. This is checked before opening, on every navigation request (links, forms, scripts), and again after any navigation (`framenavigated`), so redirects and popups can't take it elsewhere. Popups (`window.open`, `target=_blank` links) open as **tabs** (up to 5 per thread, sharing the thread's cookies) and become the active tab; the tool that caused one says so. A popup's first navigation is issued before its page exists (Playwright can't name its frame yet), so any navigation without a known frame is treated as a top-level page load and gets the local-sites check; a popup headed elsewhere (e.g. a sign-in site) is blocked before the request leaves and closed. Closing a tab returns to the one active before it. Pages may still load their own assets (fonts, CDN scripts).
- **t3 mini is off-limits.** No request at all (page, fetch, iframe) may reach t3 mini's ports: `PORT`/4310, the phone gateway (`T3_MINI_PHONE_PORT`/4311), and the Tailscale port (`T3_MINI_TAILSCALE_PORT`/8443). Otherwise an agent could open t3 mini and approve its own requests. (t3 mini's own same-origin checks would refuse cross-origin calls anyway; this closes the same-origin path.)
- **No risky abilities:** no script evaluation, no file uploads, no downloads, no service workers, no permissions (camera, location…). Dialogs are dismissed and logged.
- **Page text is untrusted.** Snapshots and console output are prefixed with a note that the content comes from the website, not the user.

## Testing

`src/server/browser.test.ts`: the address rules as unit tests, plus real-browser tests against a tiny local site (open, type, click, screenshots, console and failed requests, a fake "t3 mini" port that must get no hits, outside addresses and redirects, private sessions). The real-browser tests skip themselves on machines without a supported browser.

## Stage 2 (planned, not built)

Stage 1 is invisible: you see the agent's steps and the screenshots it shares. Stage 2 is about seeing and sharing the browser. Suggested order: use stage 1 first, then build whichever of these turns out to be needed (outside sites are the quickest).

### 1. Live browser panel (the main part)

- A panel beside the chat (like the Changes panel) that shows the agent's browser live as it works, with a marker where it last clicked.
- **Take control / Hand back:** you use the page yourself (e.g. to log in or set something up), then hand it back and the agent carries on from there.
- How: stream the page with Chrome's built-in screencast (CDP `Page.startScreencast`, frames as small JPEGs) from the server to the panel; send your clicks, typing, and scrolling back as input events. Works over phone access too, since it goes through the server.
- Things to settle: who's in control at a time (the agent's actions wait or fail while you hold it), frame rate and size limits, and showing the panel only for the thread whose browser it is.
- Effort: the biggest piece (a few sessions).

### 2. Allowed outside sites, per project

- A project setting such as "Also allow: `staging.myapp.com`", for sites the agent needs beyond localhost (staging, a login on another domain). Off by default; local-only stays the default.
- How: extend `checkPageUrl()` with the project's list (exact hosts, `https` only); t3 mini's own ports stay blocked regardless.
- Effort: small.

### 3. Recording

- `browser_recording_start` / `stop`: a short clip of what the agent did (proof a flow works, or exactly where it breaks), shown in the chat like a screenshot.
- How: Playwright's video recording per session; store the file with uploads (size-capped), add a video block type and renderer.
- Effort: medium.
