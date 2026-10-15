import { useEffect, useState } from 'react'
import { CircleCheck, LoaderCircle, X } from 'lucide-react'
import type { Provider } from '../types'
import { ProviderIcon } from './ProviderIcon'

// New Claude Code / Codex versions, shown at the bottom of the sidebar on the Mac (never on a
// phone). Update runs the CLI's own updater on the server; the next turn uses the new version.

type ProviderUpdate = {
  provider: Provider
  installed: string | null
  latest: string | null
  available: boolean
  updating: boolean
}
type Row = ProviderUpdate & { error?: string; done?: string }

const names: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }
const checkEvery = 6 * 60 * 60 * 1000
// Dismissing hides a version until a newer one comes out (per browser).
const dismissedKey = 't3-mini:dismissed-updates'
function loadDismissed(): Partial<Record<Provider, string>> {
  try {
    return JSON.parse(localStorage.getItem(dismissedKey) || '{}') as Partial<
      Record<Provider, string>
    >
  } catch {
    return {}
  }
}
function saveDismissed(value: Partial<Record<Provider, string>>) {
  try {
    localStorage.setItem(dismissedKey, JSON.stringify(value))
  } catch {
    /* Storage unavailable: it shows again next time. */
  }
}

async function request<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: '{}' }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data as T
}

export function ProviderUpdates({
  enabled,
  onUpdated,
}: {
  enabled: boolean
  onUpdated: (provider: Provider, version: string | null) => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [dismissed, setDismissed] = useState(loadDismissed)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const check = () =>
      request<{ updates: ProviderUpdate[] }>('provider-updates')
        .then(({ updates }) => {
          if (cancelled) return
          // Keep a just-finished row ("Updated to …") until it fades out.
          setRows((current) =>
            updates.map((item) => {
              const previous = current.find((row) => row.provider === item.provider)
              return previous?.done ? previous : item
            }),
          )
        })
        .catch(() => {
          /* Offline or no registry: no update offered. */
        })
    void check()
    const timer = setInterval(check, checkEvery)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled])

  const patch = (provider: Provider, change: Partial<Row>) =>
    setRows((current) =>
      current.map((row) => (row.provider === provider ? { ...row, ...change } : row)),
    )
  async function update(provider: Provider) {
    patch(provider, { updating: true, error: undefined })
    try {
      const result = await request<ProviderUpdate>(`provider-updates/${provider}`, 'POST')
      if (result.available)
        patch(provider, { ...result, error: 'The update finished but the version did not change.' })
      else {
        patch(provider, { ...result, done: result.installed ?? 'the latest version' })
        onUpdated(provider, result.installed)
        setTimeout(() => patch(provider, { done: undefined }), 6000)
      }
    } catch (error) {
      patch(provider, {
        updating: false,
        error: error instanceof Error ? error.message : 'Update failed.',
      })
    }
  }

  const visible = rows.filter(
    (row) => row.done || row.updating || (row.available && dismissed[row.provider] !== row.latest),
  )
  if (!enabled || !visible.length) return null
  const dismiss = () => {
    const next = { ...dismissed }
    for (const row of visible) if (row.latest && !row.updating) next[row.provider] = row.latest
    setDismissed(next)
    saveDismissed(next)
    setRows((current) => current.map((row) => (row.updating ? row : { ...row, done: undefined })))
  }
  const pending = visible.filter((row) => !row.done)
  return (
    <section className="provider-updates" aria-label="Agent updates">
      <div className="provider-updates-head">
        <strong>{pending.length ? 'Updates available' : 'Updated'}</strong>
        <button className="icon-button" aria-label="Hide updates" title="Hide" onClick={dismiss}>
          <X size={13} />
        </button>
      </div>
      {visible.map((row) => (
        <div className="provider-update" key={row.provider}>
          <ProviderIcon provider={row.provider} size={14} />
          <div className="provider-update-text">
            <span>{names[row.provider]}</span>
            <small className={row.error ? 'error' : undefined}>
              {row.error ??
                (row.done
                  ? `Updated to ${row.done}`
                  : row.updating
                    ? 'Updating…'
                    : `${row.installed} → ${row.latest}`)}
            </small>
          </div>
          {row.done ? (
            <CircleCheck size={15} className="provider-update-done" />
          ) : (
            <button
              className="secondary"
              disabled={row.updating}
              onClick={() => void update(row.provider)}
            >
              {row.updating ? <LoaderCircle size={13} className="status-spinner" /> : null}
              {row.updating ? 'Updating' : 'Update'}
            </button>
          )}
        </div>
      ))}
    </section>
  )
}
