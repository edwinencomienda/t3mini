import { useEffect, useRef, useState } from 'react'
import { AppWindow, Code2, Maximize2, RotateCcw, TriangleAlert } from 'lucide-react'
import { CopyButton } from './CopyButton'
import { Modal } from './Modal'

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
// passed in as CSS variables.

const policy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')
const tokens = [
  '--background',
  '--foreground',
  '--card',
  '--muted',
  '--muted-foreground',
  '--border',
  '--primary',
  '--font-sans',
  '--font-mono',
]
// Reports the page's height to the card (only a number goes out).
const sizer = `(function(){var last=0;function post(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;parent.postMessage({t3html:'size',h:h},'*')}}addEventListener('load',post);new ResizeObserver(post).observe(document.documentElement);setTimeout(post,50)})()`

const pages = new Map<string, Promise<string>>()
const loadPage = (id: string) => {
  let page = pages.get(id)
  if (!page) {
    page = fetch(`/api/html/${encodeURIComponent(id)}`).then((response) => {
      if (!response.ok) throw new Error('missing')
      return response.text()
    })
    page.catch(() => pages.delete(id))
    pages.set(id, page)
  }
  return page
}

function themeStyle() {
  const style = getComputedStyle(document.documentElement)
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  const vars = tokens.map((name) => `${name}:${style.getPropertyValue(name).trim()}`).join(';')
  return `:root{${vars};color-scheme:${dark ? 'dark' : 'light'}}html,body{margin:0;background:transparent;color:var(--foreground);font:14px/1.5 var(--font-sans)}body{padding:12px}`
}
// The agent's HTML can't break out of this: its tags all land inside <body>.
const document_ = (html: string, theme: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}</style><script>${sizer}</script></head><body>${html}</body></html>`

function useTheme() {
  const [theme, setTheme] = useState('')
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
  title,
  maxHeight,
  onEscaped,
}: {
  html: string
  title: string
  maxHeight: number
  onEscaped: () => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const loads = useRef(0)
  const [height, setHeight] = useState(160)
  const theme = useTheme()
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data as { t3html?: string; h?: unknown }
      if (data?.t3html === 'size' && typeof data.h === 'number' && Number.isFinite(data.h))
        setHeight(Math.max(40, Math.min(maxHeight, Math.ceil(data.h))))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [maxHeight])
  if (!theme) return null
  return (
    <iframe
      ref={frame}
      className="html-frame"
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document_(html, theme)}
      style={{ height }}
      onLoad={() => {
        // The first load is ours; another one means the page navigated itself elsewhere.
        loads.current += 1
        if (loads.current > 1) onEscaped()
      }}
    />
  )
}

export function HtmlView({ id, title }: { id: string; title?: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [source, setSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Bumped to rebuild the frame (after it tried to navigate away, or on Reload).
  const [run, setRun] = useState(0)
  const [escaped, setEscaped] = useState(false)
  useEffect(() => {
    let current = true
    loadPage(id).then(
      (page) => current && setHtml(page),
      () => current && setFailed(true),
    )
    return () => {
      current = false
    }
  }, [id])
  const label = title || 'HTML from the agent'
  const restart = () => setRun((value) => value + 1)
  // Stopped, not restarted: running it again would just try again (you can, with Run again).
  const escape = () => {
    setEscaped(true)
    setExpanded(false)
  }
  const runAgain = () => {
    setEscaped(false)
    restart()
  }
  return (
    <figure className="html-card">
      <header className="html-card-head">
        <AppWindow size={14} aria-hidden />
        <span className="html-card-title">{label}</span>
        {html ? (
          <span className="html-card-actions">
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
      </header>
      {failed ? (
        <p className="html-card-note">This page couldn’t be loaded.</p>
      ) : !html ? (
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
        <Frame key={run} html={html} title={label} maxHeight={720} onEscaped={escape} />
      )}
      {expanded && html && !escaped ? (
        <Modal className="new-dialog html-dialog" label={label} onClose={() => setExpanded(false)}>
          <Frame
            key={`full-${run}`}
            html={html}
            title={label}
            maxHeight={Math.round(window.innerHeight * 0.85)}
            onEscaped={escape}
          />
        </Modal>
      ) : null}
    </figure>
  )
}
