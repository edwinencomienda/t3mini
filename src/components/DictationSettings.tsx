import { useEffect, useState, type FormEvent } from 'react'
import { Check, ChevronsUpDown, Mic } from 'lucide-react'
import { Select } from '@base-ui/react/select'
import { dictationSupported, loadMicrophone, saveMicrophone } from './Dictation'

// Which microphone dictation records from. Browsers only reveal device names after the page
// has had microphone permission once, so until then this offers to ask.
function MicrophonePicker() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selected, setSelected] = useState(loadMicrophone)
  const [error, setError] = useState('')
  const refresh = () =>
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) =>
        setDevices(
          // "default"/"communications" are aliases of real devices; "System default" covers them.
          list.filter(
            (device) =>
              device.kind === 'audioinput' &&
              device.deviceId &&
              !['default', 'communications'].includes(device.deviceId),
          ),
        ),
      )
      .catch(() => setDevices([]))
  useEffect(() => {
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [])
  const named = devices.some((device) => device.label)
  async function allow() {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      await refresh()
    } catch {
      setError('Microphone access was blocked. Allow it in your browser’s site settings.')
    }
  }
  const current = devices.find((device) => device.deviceId === selected)
  const options = [
    { value: '', label: 'System default' },
    // A saved microphone that isn't plugged in stays selectable so the choice isn't lost.
    ...(selected && !current
      ? [{ value: selected, label: 'Saved microphone (not connected)' }]
      : []),
    ...devices.map((device, index) => ({
      value: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    })),
  ]
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>Microphone</strong>
          <small>
            {named
              ? 'Used for dictation in this browser. Falls back to the system default if unplugged.'
              : 'Allow microphone access once to see your microphones by name.'}
          </small>
        </div>
        {named ? (
          // The list is portaled, so the scrolling settings panel can't clip it.
          <Select.Root
            items={options}
            value={selected}
            onValueChange={(value: string | null) => {
              const next = value ?? ''
              saveMicrophone(next)
              setSelected(next)
            }}
          >
            <Select.Trigger className="mic-select" aria-label="Microphone">
              <Select.Value className="mic-select-value" />
              <Select.Icon className="mic-select-icon">
                <ChevronsUpDown size={13} />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner className="picker-positioner" sideOffset={4} collisionPadding={8}>
                <Select.Popup className="picker-menu mic-select-menu">
                  {options.map((option) => (
                    <Select.Item key={option.value} value={option.value} className="mic-option">
                      <Select.ItemText>{option.label}</Select.ItemText>
                      <Select.ItemIndicator className="picker-check">
                        <Check size={14} />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        ) : (
          <button className="secondary" type="button" onClick={() => void allow()}>
            <Mic size={13} />
            Allow microphone access
          </button>
        )}
      </div>
      {error ? <p className="phone-error">{error}</p> : null}
    </>
  )
}

type Status = {
  configured: boolean
  source: 'environment' | 'settings' | null
  hint: string | null
}

async function call<T>(method: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/dictation', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data as T
}

// Settings → Dictation: paste a Deepgram API key. The server checks it with Deepgram and keeps
// it; this page only ever sees whether one is set and its last four characters.
export function DictationSettings({ onChange }: { onChange: (configured: boolean) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    call<Status>('GET').then(setStatus, (error: Error) => setError(error.message))
  }, [])
  async function run(action: () => Promise<Status>) {
    setBusy(true)
    setError('')
    try {
      const next = await action()
      setStatus(next)
      setEditing(false)
      setKey('')
      onChange(next.configured)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (key.trim()) void run(() => call<Status>('POST', { apiKey: key.trim() }))
  }
  const showForm = status && status.source !== 'environment' && (!status.configured || editing)
  return (
    <section className="settings-section">
      <h3>Dictation</h3>
      <div className="setting-row">
        <div>
          <strong>Deepgram API key</strong>
          <small>
            {status?.source === 'environment'
              ? `Set by the DEEPGRAM_API_KEY environment variable (ends in ${status.hint}).`
              : status?.configured
                ? `Saved on this Mac (ends in ${status.hint}). The microphone button is on.`
                : 'Paste a key from console.deepgram.com to turn on the microphone button. It stays on this Mac and is never shown again.'}
          </small>
        </div>
        {status?.source === 'settings' && !editing ? (
          <div className="key-actions">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              Replace
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void run(() => call<Status>('DELETE'))}
            >
              Remove
            </button>
          </div>
        ) : null}
      </div>
      {showForm ? (
        <form className="key-form" onSubmit={save}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="Deepgram API key"
            placeholder="Deepgram API key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy}
          />
          <button className="primary" disabled={busy || !key.trim()}>
            {busy ? 'Checking…' : 'Save'}
          </button>
          {editing ? (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setKey('')
              }}
            >
              Cancel
            </button>
          ) : null}
        </form>
      ) : null}
      {error ? <p className="phone-error">{error}</p> : null}
      {dictationSupported() ? <MicrophonePicker /> : null}
    </section>
  )
}
