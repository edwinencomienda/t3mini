import { useEffect, useState } from 'react'
import { Lock, RefreshCw, ShieldAlert, Smartphone, Trash2 } from 'lucide-react'
import { Segmented, Toggle } from './ui'

type Device = { id: string; name: string; createdAt: string; lastSeenAt: string; expiresAt: string }
type Mode = 'lan' | 'tailscale'
type Status = {
  enabled: boolean
  mode: Mode
  port: number
  addresses: string[]
  url?: string
  devices: Device[]
  tailscale: { available: boolean; running: boolean; dnsName?: string; problem?: string }
}
type Pairing = { expiresAt: string; links: { url: string; qr: string }[] }

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data as T
}
const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

// Tailscale's "approve Serve/HTTPS" link in an error becomes clickable (only that site).
function withTailscaleLink(message: string) {
  const link = message.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0]
  if (!link) return message
  const [before, after] = message.split(link)
  return (
    <>
      {before}
      <a href={link} target="_blank" rel="noopener noreferrer">
        Open the Tailscale admin page
      </a>
      {after} (then turn Allow phones on again)
    </>
  )
}

// Settings section for opening t3 mini to your phone: over the local network (plain HTTP), or
// over Tailscale (HTTPS, from anywhere on your tailnet).
export function PhoneAccess({ onChange }: { onChange: (enabled: boolean) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  // The connection to use: what's running, else Tailscale when it's ready, else the network.
  const [mode, setMode] = useState<Mode | null>(null)
  const shownMode: Mode =
    mode ?? (status?.enabled ? status.mode : status?.tailscale.running ? 'tailscale' : 'lan')
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    call<Status>('remote').then(setStatus, (error: Error) => setError(error.message))
  }, [])
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])
  // Refresh the device list while a QR code is up, so a new phone appears once it pairs.
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => call<Status>('remote').then(setStatus, () => {}), 3000)
    return () => clearInterval(timer)
  }, [pairing])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const apply = (enabled: boolean, next: Mode = shownMode) =>
    run(async () => {
      const updated = await call<Status>('remote', 'POST', { enabled, mode: next })
      setStatus(updated)
      setPairing(null)
      onChange(updated.enabled)
    })
  const choose = (next: Mode) => {
    setMode(next)
    // Already on: switch the running gateway over (old QR codes stop working).
    if (status?.enabled && status.mode !== next) void apply(true, next)
  }
  const recheck = () => run(async () => setStatus(await call<Status>('remote')))
  const tailscaleBlocked = shownMode === 'tailscale' && !status?.tailscale.running
  const newCode = () =>
    run(async () => {
      setPairing(await call<Pairing>('remote/pair', 'POST', {}))
      setSelected(0)
    })
  const revoke = (id?: string) =>
    run(async () => setStatus(await call<Status>('remote/devices', 'DELETE', id ? { id } : {})))
  const secondsLeft = pairing
    ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - now) / 1000))
    : 0
  const link = pairing?.links[selected]
  return (
    <section className="settings-section">
      <h3>Phone access</h3>
      <div className="setting-row">
        <div>
          <strong>Connection</strong>
          <small>
            {shownMode === 'tailscale'
              ? 'Encrypted (HTTPS) and works from anywhere: the phone needs the Tailscale app, signed in to the same tailnet.'
              : 'Plain HTTP on your local Wi-Fi: the phone must be on the same network.'}
          </small>
        </div>
        <Segmented
          label="Connection"
          value={shownMode}
          onChange={choose}
          options={[
            { value: 'lan', label: 'Local network' },
            { value: 'tailscale', label: 'Tailscale (HTTPS)' },
          ]}
        />
      </div>
      {tailscaleBlocked && status ? (
        <p className="phone-note phone-tailscale-problem">
          <span>{status.tailscale.problem ?? 'Tailscale is not connected.'}</span>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => void recheck()}
          >
            <RefreshCw size={13} />
            Check again
          </button>
        </p>
      ) : null}
      <div className="setting-row">
        <div>
          <strong>Allow phones</strong>
          <small>
            Use t3 mini from your phone's browser. Turns off whenever the server restarts.
          </small>
        </div>
        <Toggle
          label="Allow phones"
          checked={Boolean(status?.enabled)}
          disabled={!status || busy || (!status.enabled && tailscaleBlocked)}
          onChange={(enabled) => void apply(enabled)}
        />
      </div>
      {status?.enabled ? (
        <>
          {status.mode === 'tailscale' ? (
            <p className="phone-secure">
              <Lock size={14} />
              <span>
                Encrypted, and only devices on your tailnet can reach it: <code>{status.url}</code>.
                Phones still pair with a code below.
              </span>
            </p>
          ) : (
            <p className="phone-warning">
              <ShieldAlert size={14} />
              <span>
                Only on a network you trust, like home Wi-Fi. Traffic isn't encrypted, so anyone on
                the same network who can see it could take over a paired phone and control agents on
                this Mac. Tailscale (HTTPS) avoids this.
              </span>
            </p>
          )}
          {!status.addresses.length ? (
            <p className="phone-note">No local network address found. Connect to Wi-Fi first.</p>
          ) : pairing && link ? (
            <div className="phone-pairing">
              {secondsLeft > 0 ? (
                <img src={link.qr} alt="QR code to connect your phone" width={180} height={180} />
              ) : (
                <div className="phone-expired">Code expired</div>
              )}
              <div className="phone-pairing-text">
                <strong>Scan with your phone's camera</strong>
                <small>
                  {secondsLeft > 0
                    ? `Works once · expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
                    : 'This code expired.'}
                </small>
                {pairing.links.length > 1 ? (
                  <Segmented
                    label="Network address"
                    value={String(selected)}
                    onChange={(index) => setSelected(Number(index))}
                    options={pairing.links.map((item, index) => ({
                      value: String(index),
                      label: new URL(item.url).hostname,
                    }))}
                  />
                ) : null}
                <code className="phone-url">{new URL(link.url).host}</code>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void newCode()}
                >
                  <RefreshCw size={13} />
                  New code
                </button>
              </div>
            </div>
          ) : (
            <button
              className="secondary phone-connect"
              type="button"
              disabled={busy}
              onClick={() => void newCode()}
            >
              <Smartphone size={14} />
              Connect a phone
            </button>
          )}
        </>
      ) : null}
      {status?.devices.length ? (
        <div className="phone-devices">
          <div className="phone-devices-header">
            <span>Paired devices</span>
            <button
              className="link-button"
              type="button"
              disabled={busy}
              onClick={() => void revoke()}
            >
              Revoke all
            </button>
          </div>
          {status.devices.map((device) => (
            <div className="phone-device" key={device.id}>
              <Smartphone size={14} />
              <div>
                <span>{device.name}</span>
                <small>
                  Last seen {ago(device.lastSeenAt)} · expires{' '}
                  {new Date(device.expiresAt).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                  })}
                </small>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label={`Revoke ${device.name}`}
                title="Revoke"
                disabled={busy}
                onClick={() => void revoke(device.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <p className="phone-error">{withTailscaleLink(error)}</p> : null}
    </section>
  )
}
