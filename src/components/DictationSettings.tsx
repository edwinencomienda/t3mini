import { useEffect, useState, type FormEvent } from 'react'
import { Check, ChevronsUpDown, Mic } from 'lucide-react'
import { Select } from '@base-ui/react/select'
import {
  dictationSupported,
  loadDictationSounds,
  loadMicrophone,
  loadThreadWords,
  saveDictationSounds,
  saveThreadWords,
  saveMicrophone,
} from './Dictation'
import { Segmented, Toggle } from './ui'
import { playCue } from '../sound'

// Which microphone dictation records from. Browsers only reveal device names after the page
// has had microphone permission once, so until then this offers to ask.
function MicrophonePicker({ provider }: { provider: string }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selected, setSelected] = useState(loadMicrophone)
  const [sounds, setSounds] = useState(loadDictationSounds)
  const [threadWords, setThreadWords] = useState(loadThreadWords)
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
      <div className="setting-row">
        <div>
          <strong>Recording sounds</strong>
          <small>Play a short sound when dictation starts and stops.</small>
        </div>
        <Toggle
          label="Recording sounds"
          checked={sounds}
          onChange={(on) => {
            saveDictationSounds(on)
            setSounds(on)
            if (on) playCue('start')
          }}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>Use words from the thread</strong>
          <small>
            Helps spell names and code terms: up to 40 unusual words from the agent’s last two
            replies go to {provider} with your audio. Code blocks, links, and anything that looks
            like a key are never included.
          </small>
        </div>
        <Toggle
          label="Use words from the thread"
          checked={threadWords}
          onChange={(on) => {
            saveThreadWords(on)
            setThreadWords(on)
          }}
        />
      </div>
      {error ? <p className="phone-error">{error}</p> : null}
    </>
  )
}

type Provider = 'deepgram' | 'assemblyai'
type KeyStatus = {
  configured: boolean
  source: 'environment' | 'settings' | null
  hint: string | null
}
type Status = KeyStatus & {
  provider: Provider
  live: boolean
  keys: Record<Provider, KeyStatus>
}

const services: Record<
  Provider,
  { name: string; env: string; site: string; about: string; privacy: string }
> = {
  deepgram: {
    name: 'Deepgram',
    env: 'DEEPGRAM_API_KEY',
    site: 'console.deepgram.com',
    about: 'Words appear as you talk.',
    privacy: 'Deepgram',
  },
  assemblyai: {
    name: 'AssemblyAI',
    env: 'ASSEMBLYAI_API_KEY',
    site: 'assemblyai.com/dashboard',
    about:
      'Its Dictation API: when you stop, the recording becomes clean, ready-to-send text (filler words and self-corrections tidied, fast mode). Nothing shows while you talk.',
    privacy: 'AssemblyAI',
  },
}

async function call<T>(method: string, body?: unknown, path = '/api/dictation'): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data as T
}

// Settings → Dictation: which service turns speech into text (Deepgram or AssemblyAI), and its
// API key. The server checks a key with its service and keeps it; this page only ever sees
// whether one is set and its last four characters.
export function DictationSettings({
  onChange,
}: {
  onChange: (configured: boolean, live: boolean) => void
}) {
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
      onChange(next.configured, next.live)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const provider = status?.provider ?? 'deepgram'
  const service = services[provider]
  const keyStatus = status?.keys?.[provider] ?? status
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (key.trim()) void run(() => call<Status>('POST', { provider, apiKey: key.trim() }))
  }
  const showForm =
    keyStatus && keyStatus.source !== 'environment' && (!keyStatus.configured || editing)
  return (
    <section className="settings-section">
      <h3>Dictation</h3>
      <div className="setting-row">
        <div>
          <strong>Service</strong>
          <small>{service.about}</small>
        </div>
        <Segmented
          label="Dictation service"
          value={provider}
          options={[
            { value: 'deepgram', label: 'Deepgram' },
            { value: 'assemblyai', label: 'AssemblyAI' },
          ]}
          onChange={(next) => {
            if (next === provider || busy) return
            setEditing(false)
            setKey('')
            void run(() => call<Status>('POST', { provider: next }, '/api/dictation/provider'))
          }}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>{service.name} API key</strong>
          <small>
            {keyStatus?.source === 'environment'
              ? `Set by the ${service.env} environment variable (ends in ${keyStatus.hint}).`
              : keyStatus?.configured
                ? `Saved on this Mac (ends in ${keyStatus.hint}). The microphone button is on.`
                : `Paste a key from ${service.site} to turn on the microphone button. It stays on this Mac and is never shown again.`}
          </small>
        </div>
        {keyStatus?.source === 'settings' && !editing ? (
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
              onClick={() => void run(() => call<Status>('DELETE', { provider }))}
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
            aria-label={`${service.name} API key`}
            placeholder={`${service.name} API key`}
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
      {dictationSupported() ? <MicrophonePicker provider={service.privacy} /> : null}
    </section>
  )
}
