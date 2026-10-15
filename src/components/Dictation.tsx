import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Mic, Square } from 'lucide-react'

// Click to record, click again to stop; the audio goes to /api/transcribe (Deepgram on the
// server) and the text comes back through onText. Browsers only allow the microphone on secure
// pages, so this isn't offered over plain-HTTP phone access.
const maxSeconds = 5 * 60
const preferredTypes = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

// The chosen microphone, per browser (device ids are only valid in the browser that saw them).
const microphoneKey = 't3-mini:microphone'
export function loadMicrophone() {
  try {
    return localStorage.getItem(microphoneKey) || ''
  } catch {
    return ''
  }
}
export function saveMicrophone(deviceId: string) {
  try {
    if (deviceId) localStorage.setItem(microphoneKey, deviceId)
    else localStorage.removeItem(microphoneKey)
  } catch {
    // The choice still applies until reload.
  }
}
// Opens the chosen microphone, falling back to the system default if it's gone (unplugged).
async function openMicrophone() {
  const deviceId = loadMicrophone()
  if (deviceId)
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } })
    } catch (error) {
      // Permission denied applies to every device; anything else (unplugged, busy) falls back.
      if (error instanceof DOMException && error.name === 'NotAllowedError') throw error
    }
  return navigator.mediaDevices.getUserMedia({ audio: true })
}

export const dictationSupported = () =>
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  typeof MediaRecorder !== 'undefined'

function toBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '')
    reader.onerror = () => reject(new Error('Could not read the recording.'))
    reader.readAsDataURL(blob)
  })
}

export function DictationButton({
  onText,
  onError,
  disabled = false,
}: {
  onText: (text: string) => void
  onError: (message: string) => void
  disabled?: boolean
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [seconds, setSeconds] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const cancelled = useRef(false)
  // Callbacks change on every render; read the latest when the recording finishes.
  const handlers = useRef({ onText, onError })
  handlers.current = { onText, onError }

  const release = () => {
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
  }
  // Leaving the page or thread mid-recording drops the recording and frees the microphone.
  useEffect(
    () => () => {
      cancelled.current = true
      if (recorder.current?.state === 'recording') recorder.current.stop()
      release()
    },
    [],
  )
  useEffect(() => {
    if (state !== 'recording') return
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [state])
  useEffect(() => {
    if (state === 'recording' && seconds >= maxSeconds) recorder.current?.stop()
  }, [state, seconds])

  async function start() {
    try {
      stream.current = await openMicrophone()
    } catch {
      handlers.current.onError(
        'Microphone access was blocked. Allow it in your browser to dictate.',
      )
      return
    }
    const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type))
    const media = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    media.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data)
    }
    media.onstop = async () => {
      release()
      if (cancelled.current) return
      const audio = new Blob(chunks, { type: media.mimeType || mimeType || 'audio/webm' })
      if (!audio.size) {
        setState('idle')
        return
      }
      setState('transcribing')
      try {
        const response = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mimeType: audio.type, data: await toBase64(audio) }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Dictation failed.')
        if (data.text) handlers.current.onText(data.text)
        else handlers.current.onError('No speech was heard. Try again a bit closer to the mic.')
      } catch (error) {
        handlers.current.onError(error instanceof Error ? error.message : 'Dictation failed.')
      } finally {
        if (!cancelled.current) setState('idle')
      }
    }
    recorder.current = media
    cancelled.current = false
    setSeconds(0)
    media.start()
    setState('recording')
  }
  const stop = () => recorder.current?.stop()

  const recording = state === 'recording'
  const label =
    state === 'recording'
      ? `Stop dictation (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')})`
      : state === 'transcribing'
        ? 'Transcribing…'
        : 'Dictate'
  return (
    <button
      type="button"
      className={`round-button dictation-button ${state}`}
      aria-label={label}
      title={label}
      aria-pressed={recording}
      disabled={state === 'transcribing' || (disabled && !recording)}
      onClick={() => (recording ? stop() : void start())}
    >
      {state === 'transcribing' ? (
        <LoaderCircle size={14} className="status-spinner" />
      ) : recording ? (
        <>
          <Square size={9} fill="currentColor" />
          <span className="dictation-time">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </span>
        </>
      ) : (
        <Mic size={15} />
      )}
    </button>
  )
}
