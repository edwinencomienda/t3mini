import { useEffect, useState } from 'react'
import { Input } from '@base-ui/react/input'
import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { copyText } from '../attachments'
import { useConfirm } from './ConfirmDialog'
import { Segmented } from './ui'
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
        Use t3 mini on another computer (a VPS, another Mac) from here. On that machine, open
        Settings → Machines → <strong>Add this computer to another t3 mini</strong> (or run{' '}
        <code>t3mini pair</code>) and paste the link below. Its agents run there, with its own
        Claude and Codex sign-ins.
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
      <ShareThisComputer />
    </section>
  )
}

// The other direction: let another t3 mini add this computer as a machine. Does what
// `t3mini pair` does: turns on this computer's gateway for other devices (Tailscale HTTPS, or
// the local network) and makes a one-time link (5 minutes, single use) to paste into Settings →
// Machines there. The link is a pairing code like Settings → Devices' Copy link: same gateway,
// same hashed, revocable sessions; the other computer shows up there as a paired device.
type Mode = 'lan' | 'tailscale'
type RemoteStatus = {
  enabled: boolean
  mode: Mode
  tailscale: { running: boolean; problem?: string }
}
async function remote<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'That didn’t work.')
  return data as T
}
const modeNames: Record<Mode, string> = { tailscale: 'Tailscale (HTTPS)', lan: 'Local network' }

function ShareThisComputer() {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [chosen, setChosen] = useState<Mode | null>(null)
  const [pairing, setPairing] = useState<{ url: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [confirmDialog, confirm] = useConfirm()
  // What's on, else Tailscale when it's connected, else the local network (like `t3mini pair`).
  const mode: Mode =
    chosen ?? (status?.enabled ? status.mode : status?.tailscale.running ? 'tailscale' : 'lan')
  const check = () =>
    remote<RemoteStatus>('remote').then(setStatus, (problem: Error) => setError(problem.message))
  useEffect(() => {
    void check()
  }, [])
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const blocked = mode === 'tailscale' && status !== null && !status.tailscale.running
  async function makeLink() {
    if (!status || busy) return
    // Switching an active connection drops devices using the other one, so ask first.
    if (status.enabled && status.mode !== mode) {
      const ok = await confirm({
        title: `Switch to ${modeNames[mode]}?`,
        description: (
          <>
            Other devices are connected over {modeNames[status.mode]} right now. Switching drops
            them until they reconnect over {modeNames[mode]}.
          </>
        ),
        confirmLabel: 'Switch',
      })
      if (!ok) return
    }
    setBusy(true)
    setError('')
    try {
      if (!status.enabled || status.mode !== mode)
        setStatus(await remote<RemoteStatus>('remote', { enabled: true, mode }))
      const made = await remote<{ expiresAt: string; links: { url: string }[] }>('remote/pair', {})
      const url = made.links[0]?.url
      if (!url) throw new Error('t3 mini didn’t return a pairing link.')
      setPairing({ url, expiresAt: made.expiresAt })
      setCopied(false)
      setNow(Date.now())
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const secondsLeft = pairing
    ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - now) / 1000))
    : 0
  return (
    <div className="machine-share">
      {confirmDialog}
      <h3>Add this computer to another t3 mini</h3>
      <p className="phone-note">
        Makes a one-time link to paste into Settings → Machines → Add machine on your other
        computer. It turns on access for other devices here if it’s off; this computer’s agents and
        files stay here. The other computer then shows up under Settings → Devices, where you can
        revoke it.
      </p>
      <div className="setting-row">
        <div>
          <strong>Connection</strong>
          <small>
            {mode === 'tailscale'
              ? 'Encrypted, from anywhere on your tailnet. Both computers need Tailscale.'
              : 'Plain HTTP on your local network: only on a network you trust.'}
          </small>
        </div>
        <Segmented
          label="Connection"
          value={mode}
          onChange={(value) => {
            setChosen(value)
            setPairing(null)
          }}
          options={[
            { value: 'tailscale', label: 'Tailscale (HTTPS)' },
            { value: 'lan', label: 'Local network' },
          ]}
        />
      </div>
      {blocked ? (
        <p className="phone-note phone-tailscale-problem">
          <span>{status?.tailscale.problem ?? 'Tailscale is not connected.'}</span>
          <button className="secondary" type="button" disabled={busy} onClick={() => void check()}>
            <RefreshCw size={13} />
            Check again
          </button>
        </p>
      ) : null}
      {pairing && secondsLeft > 0 ? (
        <div className="machine-link">
          <code title={pairing.url}>{pairing.url}</code>
          <small>
            Works once · expires in {Math.floor(secondsLeft / 60)}:
            {String(secondsLeft % 60).padStart(2, '0')}. Anyone with it can add this computer until
            then, so only paste it into your own t3 mini.
          </small>
          <div className="phone-pairing-actions">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void copyText(pairing.url).then(
                  () => setCopied(true),
                  () => setError('Couldn’t copy the link.'),
                )
              }
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void makeLink()}
            >
              <RefreshCw size={13} />
              New link
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="secondary machine-share-button"
          disabled={!status || busy || blocked}
          onClick={() => void makeLink()}
        >
          {busy ? <LoaderCircle size={13} className="status-spinner" /> : <Link2 size={13} />}
          {pairing ? 'Link expired · get a new one' : 'Get a pairing link'}
        </button>
      )}
      {error ? (
        <p className="phone-note machine-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
