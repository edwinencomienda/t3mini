import { useState } from 'react'
import { CircleCheck, LoaderCircle, X } from 'lucide-react'
import type { Provider } from '../types'
import { ProviderIcon } from './ProviderIcon'

// New Claude Code / Codex versions, at the bottom of the sidebar on every device (the Mac, and
// phones and tablets through the gateway): this computer's and those of each machine it follows
// (Settings → Machines). Each server checks its own CLIs in the background and pushes the result
// with its live updates (server/cli-updates.ts; a machine's come through this computer's
// hub-watch.ts as machineUpdates), so nothing is polled here. Update runs the CLI's own updater
// on the computer that has it; its next turn uses the new version.

export type ProviderUpdate = {
  provider: Provider
  installed: string | null
  latest: string | null
  available: boolean
  updating: boolean
}
// Where an update lives: this computer, or a machine (by id and name).
export type UpdateSource = { machine?: { id: string; name: string }; updates: ProviderUpdate[] }
type Local = { error?: string; done?: string; updating?: boolean }

const names: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }
// Dismissing hides a version until a newer one comes out (per browser). This computer's rows
// keep their old keys ("codex"); a machine's are "<machine>:codex".
const dismissedKey = 't3-mini:dismissed-updates'
function loadDismissed(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(dismissedKey) || '{}') as Record<string, string>
  } catch {
    return {}
  }
}
function saveDismissed(value: Record<string, string>) {
  try {
    localStorage.setItem(dismissedKey, JSON.stringify(value))
  } catch {
    /* Storage unavailable: it shows again next time. */
  }
}
const rowKey = (source: UpdateSource, provider: Provider) =>
  source.machine ? `${source.machine.id}:${provider}` : provider
// The API for a source: this computer's, or a machine's through this server (/api/m/<id>/…).
const apiFor = (source: UpdateSource) =>
  source.machine ? `/api/m/${encodeURIComponent(source.machine.id)}` : '/api'

export function ProviderUpdates({
  sources,
  onUpdated,
}: {
  sources: UpdateSource[]
  // This computer's CLI was updated (the version shown elsewhere follows).
  onUpdated: (provider: Provider, version: string | null) => void
}) {
  const [local, setLocal] = useState<Record<string, Local>>({})
  const [dismissed, setDismissed] = useState(loadDismissed)
  const patch = (key: string, change: Local) =>
    setLocal((current) => ({ ...current, [key]: { ...current[key], ...change } }))

  async function update(source: UpdateSource, provider: Provider) {
    const key = rowKey(source, provider)
    patch(key, { updating: true, error: undefined, done: undefined })
    try {
      const response = await fetch(`${apiFor(source)}/provider-updates/${provider}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const result = (await response.json()) as ProviderUpdate & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Update failed.')
      if (result.available)
        patch(key, {
          updating: false,
          error: 'The update finished but the version did not change.',
        })
      else {
        patch(key, { updating: false, done: result.installed ?? 'the latest version' })
        if (!source.machine) onUpdated(provider, result.installed)
        setTimeout(() => patch(key, { done: undefined }), 6000)
      }
    } catch (error) {
      patch(key, {
        updating: false,
        error: error instanceof Error ? error.message : 'Update failed.',
      })
    }
  }

  const rows = sources.flatMap((source) =>
    source.updates.map((item) => {
      const key = rowKey(source, item.provider)
      const mine = local[key] ?? {}
      return {
        ...item,
        key,
        source,
        updating: item.updating || Boolean(mine.updating),
        error: mine.error,
        done: mine.done,
      }
    }),
  )
  const visible = rows.filter(
    (row) =>
      row.done || row.updating || row.error || (row.available && dismissed[row.key] !== row.latest),
  )
  if (!visible.length) return null
  const dismiss = () => {
    const next = { ...dismissed }
    for (const row of visible) if (row.latest && !row.updating) next[row.key] = row.latest
    setDismissed(next)
    saveDismissed(next)
    setLocal((current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, value]) => [key, { updating: value.updating }]),
      ),
    )
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
        <div className="provider-update" key={row.key}>
          <ProviderIcon provider={row.provider} size={14} />
          <div className="provider-update-text">
            <span>
              {names[row.provider]}
              {row.source.machine ? (
                <span className="provider-update-machine"> · {row.source.machine.name}</span>
              ) : null}
            </span>
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
              onClick={() => void update(row.source, row.provider)}
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
