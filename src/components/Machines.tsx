import { useEffect, useState } from 'react'
import { Input } from '@base-ui/react/input'
import { ExternalLink, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useConfirm } from './ConfirmDialog'
import type { MachineSummary } from '../server/machines'

// Settings → Machines: other computers running t3mini (a VPS, another Mac). Add one with the
// link `t3mini pair` prints there; each opens at a local address on this Mac (server/machines.ts).
async function call<T>(method: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/machines', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'That didn’t work.')
  return data as T
}

export function Machines() {
  const [machines, setMachines] = useState<MachineSummary[] | null>(null)
  const [link, setLink] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDialog, confirm] = useConfirm()
  const refresh = () =>
    call<MachineSummary[]>('GET')
      .then(setMachines)
      .catch((problem: Error) => setError(problem.message))
  useEffect(() => {
    void refresh()
  }, [])
  async function add() {
    if (!link.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await call('POST', { link: link.trim(), ...(name.trim() ? { name: name.trim() } : {}) })
      setLink('')
      setName('')
      await refresh()
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function remove(machine: MachineSummary) {
    const ok = await confirm({
      title: `Remove ${machine.name}?`,
      description: (
        <>
          This Mac forgets it and closes its address. Nothing on {machine.name} changes; to
          disconnect fully, revoke this Mac there too (Settings → Devices on {machine.name}).
        </>
      ),
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await call('DELETE', { id: machine.id })
      await refresh()
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="settings-section">
      {confirmDialog}
      <h3>Machines</h3>
      <p className="phone-note">
        Use t3 mini on another computer (a VPS, another Mac) from here. On that machine, run{' '}
        <code>t3mini pair</code> and paste the link it prints below. Its agents run there, with its
        own Claude and Codex sign-ins.
      </p>
      <div className="machine-add">
        <Input
          className="music-url"
          aria-label="Pairing link"
          placeholder="https://…/pair?code=…"
          value={link}
          spellCheck={false}
          onValueChange={(value: string) => setLink(value)}
          onKeyDown={(event) => event.key === 'Enter' && void add()}
          disabled={busy}
        />
        <Input
          className="music-url machine-name"
          aria-label="Name (optional)"
          placeholder="Name (optional)"
          value={name}
          maxLength={60}
          onValueChange={(value: string) => setName(value)}
          onKeyDown={(event) => event.key === 'Enter' && void add()}
          disabled={busy}
        />
        <button
          type="button"
          className="secondary"
          onClick={() => void add()}
          disabled={busy || !link.trim()}
        >
          {busy ? <LoaderCircle size={13} className="status-spinner" /> : <Plus size={13} />}
          Add machine
        </button>
      </div>
      {error ? (
        <p className="phone-note machine-error" role="alert">
          {error}
        </p>
      ) : null}
      {machines === null ? (
        <p className="phone-note">Loading…</p>
      ) : machines.length ? (
        <ul className="machine-list">
          {machines.map((machine) => (
            <li key={machine.id} className="machine-row">
              <span className={`machine-dot ${machine.status}`} aria-hidden />
              <div className="machine-text">
                <strong>{machine.name}</strong>
                <small title={machine.origin}>
                  {machine.problem ?? `${machine.origin} · opens at ${machine.url}`}
                </small>
              </div>
              <a
                className="secondary machine-open"
                href={machine.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={machine.status !== 'online'}
              >
                <ExternalLink size={13} />
                Open
              </a>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${machine.name}`}
                title="Remove"
                onClick={() => void remove(machine)}
                disabled={busy}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="phone-note">No machines yet.</p>
      )}
      {machines?.length ? (
        <button type="button" className="secondary machine-refresh" onClick={() => void refresh()}>
          <RefreshCw size={13} />
          Check again
        </button>
      ) : null}
    </section>
  )
}
