import { useEffect, useState } from 'react'
import { RefreshCw, ShieldAlert, Smartphone, Trash2 } from 'lucide-react'

type Device = { id: string; name: string; createdAt: string; lastSeenAt: string; expiresAt: string }
type Status = { enabled: boolean; port: number; addresses: string[]; devices: Device[] }
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

// Settings section for opening t3 mini to your phone over the local network.
export function PhoneAccess({ onChange }: { onChange: (enabled: boolean) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
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
  const toggle = (enabled: boolean) =>
    run(async () => {
      const next = await call<Status>('remote', 'POST', { enabled })
      setStatus(next)
      setPairing(null)
      onChange(next.enabled)
    })
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
          <strong>Allow phones on this network</strong>
          <small>
            Use t3 mini from your phone's browser over your local Wi-Fi. Turns off whenever the
            server restarts.
          </small>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(status?.enabled)}
          aria-label="Allow phones on this network"
          className="toggle"
          disabled={!status || busy}
          onClick={() => void toggle(!status?.enabled)}
        >
          <span />
        </button>
      </div>
      {status?.enabled ? (
        <>
          <p className="phone-warning">
            <ShieldAlert size={14} />
            <span>
              Only on a network you trust, like home Wi-Fi. Traffic isn't encrypted, so anyone on
              the same network who can see it could take over a paired phone and control agents on
              this Mac.
            </span>
          </p>
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
                  <div className="segmented" role="radiogroup" aria-label="Network address">
                    {pairing.links.map((item, index) => (
                      <button
                        key={item.url}
                        type="button"
                        role="radio"
                        aria-checked={index === selected}
                        onClick={() => setSelected(index)}
                      >
                        {new URL(item.url).hostname}
                      </button>
                    ))}
                  </div>
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
      {error ? <p className="phone-error">{error}</p> : null}
    </section>
  )
}
