import { useEffect, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Globe, X } from 'lucide-react'
import type { BrowserInfo } from '../types'

// The composer's browser chip: shown while this thread's agent has a browser page open (the
// browser_* tools), with the page's address. Click for its title, a fresh preview (refreshed
// every few seconds while open), and Close browser.

const short = (url: string) => {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

export function BrowserChip({ threadId, browser }: { threadId: string; browser?: BrowserInfo }) {
  const [open, setOpen] = useState(false)
  const [tick, setTick] = useState(0)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    setTick(Date.now())
    const timer = setInterval(() => setTick(Date.now()), 3000)
    return () => clearInterval(timer)
  }, [open])
  useEffect(() => setFailed(false), [tick])
  if (!browser) return null
  async function close() {
    setError('')
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/browser/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => undefined)
    if (response?.ok) setOpen(false)
    else setError('Couldn’t close the browser.')
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="process-chip browser-chip" title="The agent’s browser">
        <Globe size={12} />
        <span>{short(browser.url)}</span>
        {browser.tabs > 1 ? <span className="browser-chip-tabs">+{browser.tabs - 1}</span> : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="picker-positioner"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <Popover.Popup className="process-menu browser-menu" aria-label="The agent’s browser">
            <div className="browser-menu-head">
              <div className="browser-menu-title">
                <strong>{browser.title || 'Untitled page'}</strong>
                <small>
                  {browser.url}
                  {browser.tabs > 1 ? ` · ${browser.tabs} tabs open, showing the active one` : ''}
                </small>
              </div>
              <button
                type="button"
                className="secondary browser-close"
                onClick={() => void close()}
              >
                <X size={13} />
                Close browser
              </button>
            </div>
            {failed ? (
              <p className="browser-preview-note">No preview right now.</p>
            ) : tick ? (
              <img
                className="browser-preview"
                src={`/api/threads/${encodeURIComponent(threadId)}/browser/preview?t=${tick}`}
                alt={`The agent’s browser showing ${browser.title || browser.url}`}
                onError={() => setFailed(true)}
              />
            ) : null}
            <p className="browser-preview-note">
              The agent’s own private browser, local sites only. It closes by itself after 10 idle
              minutes.
            </p>
            {error ? <p className="picker-error">{error}</p> : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
