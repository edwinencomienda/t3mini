import { useEffect, useRef, useState } from 'react'
import { useApiBase } from '../hub'
import { AppWindow, Code2, Maximize2, RotateCcw, TriangleAlert } from 'lucide-react'
import { CopyButton } from './CopyButton'
import { Modal } from './Modal'
import { loadLibraries, pageDocument, pageTokens, themeCss, type PageLibrary } from '../html-page'

// An agent's HTML page (show_html) in a card. The HTML is untrusted (the agent may have copied
// it, or been tricked by something it read), so it runs sealed off from t3 mini:
//
// - sandbox="allow-scripts" only, without allow-same-origin: the page gets an opaque origin of
//   its own, so it can't reach t3 mini's page, storage, cookies, or API (which runs commands).
//   No popups, forms, top navigation, modals, downloads, or pointer lock either.
// - Our Content-Security-Policy comes first in its <head>: no network at all (no fetch,
//   WebSockets, external scripts, styles, fonts, or images; only inline code and data: URLs).
//   The agent's HTML goes in <body>, where a CSP <meta> is ignored, so it can't loosen this.
// - If the page navigates its own frame elsewhere, it's put back and you're told.
//
// Its height follows the content (a small script posts it), and the app's theme colors are
// passed in as CSS variables. A page that asked for a bundled library (Chart.js) gets it
// inlined, still with no network.

const pages = new Map<string, Promise<string>>()
// Pages already fetched, and each frame's last height, so coming back to a thread draws the card
// straight away at its size instead of going Loading… → 160px → real height every time.
const loaded = new Map<string, string>()
const heights = new Map<string, number>()
// `base`: where the thread lives, here or on a machine (the hub's ApiBase).
const loadPage = (base: string, id: string) => {
  const key = `${base}/${id}`
  let page = pages.get(key)
  if (!page) {
    page = fetch(`${base}/html/${encodeURIComponent(id)}`).then((response) => {
      if (!response.ok) throw new Error('missing')
      return response.text()
    })
    page.then((text) => loaded.set(key, text)).catch(() => {})
    page.catch(() => pages.delete(key))
    pages.set(key, page)
  }
  return page
}

function themeStyle() {
  if (typeof document === 'undefined') return ''
  const style = getComputedStyle(document.documentElement)
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  const values = Object.fromEntries(
    pageTokens.map((name) => [name, style.getPropertyValue(name).trim()]),
  )
  return themeCss(values, dark)
}
// The page itself is built by pageDocument() (src/html-page.ts), shared with the server's render
// check. The agent's HTML can't break out of it: its tags all land inside <body>. In the reply
// the frame is as tall as its page, so it never scrolls inside (inline); full screen it may.
// Pages already shown in this tab (see settledHead in html-page.ts).
const shown = new Set<string>()
// A page sized to its window (100vh) grows each time its frame does: after this many growths
// in quick succession its height is kept where it is.
const runaway = 10

function useTheme() {
  // Read right away (not after mounting), so the frame isn't held back a render.
  const [theme, setTheme] = useState(themeStyle)
  useEffect(() => {
    const update = () => setTheme(themeStyle())
    update()
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    // The theme switch (in this window or another) sets data-theme on <html>.
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => {
      media.removeEventListener('change', update)
      observer.disconnect()
    }
  }, [])
  return theme
}

function Frame({
  html,
  libraries,
  title,
  maxHeight,
  inline = false,
  still = false,
  sizeKey,
  onEscaped,
}: {
  html: string
  libraries: { name: PageLibrary; source: string }[]
  title: string
  maxHeight: number
  // In the reply: no scrolling inside, the frame takes the page's whole height.
  inline?: boolean
  // Shown before: opens finished instead of playing its entrance animations again.
  still?: boolean
  // Where this frame's height is remembered (one per page, card or full screen).
  sizeKey: string
  onEscaped: () => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const loads = useRef(0)
  const [height, setHeight] = useState(() => Math.min(maxHeight, heights.get(sizeKey) ?? 160))
  const theme = useTheme()
  const growth = useRef({ height: 0, streak: 0, at: 0, stuck: false })
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data as { t3html?: string; h?: unknown }
      if (data?.t3html === 'size' && typeof data.h === 'number' && Number.isFinite(data.h)) {
        const next = Math.max(40, Math.min(maxHeight, Math.ceil(data.h)))
        const grew = growth.current
        if (next > grew.height) {
          const now = Date.now()
          grew.streak = now - grew.at < 200 ? grew.streak + 1 : 0
          grew.at = now
          if (grew.streak >= runaway) grew.stuck = true
          if (grew.stuck) return
        }
        grew.height = next
        heights.set(sizeKey, next)
        setHeight(next)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [maxHeight, sizeKey])
  if (!theme) return null
  return (
    <iframe
      ref={frame}
      className="html-frame"
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={pageDocument({ html, theme, inline, still, libraries })}
      style={{ height }}
      onLoad={() => {
        // The first load is ours; another one means the page navigated itself elsewhere.
        loads.current += 1
        if (loads.current > 1) onEscaped()
      }}
    />
  )
}

const noLibraries: { name: PageLibrary; source: string }[] = []

export function HtmlView({
  id,
  title,
  libraries: wanted,
}: {
  id: string
  title?: string
  libraries?: PageLibrary[]
}) {
  const base = useApiBase()
  const key = `${base}/${id}`
  const [html, setHtml] = useState<string | null>(() => loaded.get(key) ?? null)
  const [failed, setFailed] = useState(false)
  // Bundled libraries the page asked for, loaded before it's drawn.
  const [libraries, setLibraries] = useState(wanted?.length ? null : noLibraries)
  const wantedKey = wanted?.join(',') ?? ''
  useEffect(() => {
    if (!wantedKey) return
    let current = true
    loadLibraries(wantedKey.split(',') as PageLibrary[]).then(
      (loaded) => current && setLibraries(loaded),
      () => current && setFailed(true),
    )
    return () => {
      current = false
    }
  }, [wantedKey])
  const [source, setSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Bumped to rebuild the frame (after it tried to navigate away, or on Reload).
  const [run, setRun] = useState(0)
  const [escaped, setEscaped] = useState(false)
  // Seen before in this tab: opens finished (see settledHead in html-page.ts). Reload plays it again.
  const [still, setStill] = useState(() => shown.has(key))
  useEffect(() => {
    shown.add(key)
  }, [key])
  useEffect(() => {
    let current = true
    loadPage(base, id).then(
      (page) => current && setHtml(page),
      () => current && setFailed(true),
    )
    return () => {
      current = false
    }
  }, [base, id])
  const label = title || 'HTML from the agent'
  const restart = () => setRun((value) => value + 1)
  // Stopped, not restarted: running it again would just try again (you can, with Run again).
  const escape = () => {
    setEscaped(true)
    setExpanded(false)
  }
  const runAgain = () => {
    setEscaped(false)
    setStill(false)
    restart()
  }
  // No frame: the page sits in the reply like the rest of it. Its title and buttons are a quiet
  // row under it (shown on hover or focus, always on touch screens), so they never cover it.
  const actions = (
    <figcaption className="inline-tool-bar">
      <AppWindow size={13} aria-hidden />
      <span className="inline-tool-title">{label}</span>
      {html ? (
        <span className="inline-tool-actions">
          <button
            type="button"
            className="icon-button"
            title="Reload"
            aria-label="Reload"
            onClick={runAgain}
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            className={`icon-button ${source ? 'active' : ''}`}
            title={source ? 'Show page' : 'View source'}
            aria-label={source ? 'Show page' : 'View source'}
            aria-pressed={source}
            onClick={() => setSource((value) => !value)}
          >
            <Code2 size={14} />
          </button>
          <CopyButton className="html-copy" label="Copy HTML" text={() => html} />
          <button
            type="button"
            className="icon-button"
            title="Expand"
            aria-label="Expand"
            onClick={() => setExpanded(true)}
          >
            <Maximize2 size={13} />
          </button>
        </span>
      ) : null}
    </figcaption>
  )
  return (
    <figure className="inline-tool html-card" aria-label={label}>
      {failed ? (
        <p className="html-card-note">This page couldn’t be loaded.</p>
      ) : !html || !libraries ? (
        <p className="html-card-note">Loading…</p>
      ) : source ? (
        <pre className="html-source">{html}</pre>
      ) : escaped ? (
        <p className="html-card-note warning">
          <TriangleAlert size={13} />
          <span>The page tried to go to another address, so it was stopped.</span>
          <button type="button" className="secondary html-run-again" onClick={runAgain}>
            Run again
          </button>
        </p>
      ) : (
        <Frame
          key={run}
          html={html}
          libraries={libraries}
          title={label}
          // Tall enough for any real page; a cap only against one that keeps growing.
          maxHeight={4000}
          inline
          still={still}
          sizeKey={key}
          onEscaped={escape}
        />
      )}
      {expanded && html && libraries && !escaped ? (
        <Modal className="new-dialog html-dialog" label={label} onClose={() => setExpanded(false)}>
          <Frame
            key={`full-${run}`}
            html={html}
            libraries={libraries}
            title={label}
            maxHeight={Math.round(window.innerHeight * 0.85)}
            sizeKey={`${key}#full`}
            onEscaped={escape}
          />
        </Modal>
      ) : null}
      {actions}
    </figure>
  )
}
