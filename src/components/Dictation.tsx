import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Mic, Square } from 'lucide-react'
import { playCue } from '../sound'

// Click to record, click again to stop. While you speak, the audio streams to the server's
// /api/dictation/stream WebSocket (relayed to Deepgram's live API) and the words so far come back
// through onPreview; on stop the final text goes through onText. If streaming can't be used, the
// whole recording is sent to /api/transcribe instead. Browsers only allow the microphone on
// secure pages, so this isn't offered over plain-HTTP phone access.
const maxSeconds = 5 * 60
// How often the recorder hands over audio while streaming.
const chunkMs = 250
// How long to wait for Deepgram's last words after stopping before using the fallback.
const finishTimeoutMs = 8_000
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
// Start/stop sounds, per browser (on unless turned off in Settings → Dictation).
const soundsKey = 't3-mini:dictation-sounds'
export function loadDictationSounds() {
  try {
    return localStorage.getItem(soundsKey) !== 'off'
  } catch {
    return true
  }
}
export function saveDictationSounds(on: boolean) {
  try {
    localStorage.setItem(soundsKey, on ? 'on' : 'off')
  } catch {
    // The choice still applies until reload.
  }
}
// Thread vocabulary: the server sends unusual words from the agent's last replies to Deepgram as
// keyterms (per browser, on unless turned off in Settings → Dictation).
const threadWordsKey = 't3-mini:dictation-thread-words'
export function loadThreadWords() {
  try {
    return localStorage.getItem(threadWordsKey) !== 'off'
  } catch {
    return true
  }
}
export function saveThreadWords(on: boolean) {
  try {
    localStorage.setItem(threadWordsKey, on ? 'on' : 'off')
  } catch {
    // The choice still applies until reload.
  }
}
// Which thread to take vocabulary from, if that's turned on.
const vocabularyThread = (threadId?: string) =>
  threadId && loadThreadWords() ? threadId : undefined
const cue = (kind: 'start' | 'stop') => {
  if (loadDictationSounds()) playCue(kind)
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

// Sends a finished recording in one piece: the fallback when streaming isn't available.
async function transcribeRecording(audio: Blob, thread?: string) {
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread, mimeType: audio.type, data: await toBase64(audio) }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Dictation failed.')
  return String(data.text ?? '')
}

// A live-transcription session over the server's WebSocket relay.
function openStream(onWords: (text: string) => void, thread?: string) {
  const socket = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/dictation/stream${
      thread ? `?thread=${encodeURIComponent(thread)}` : ''
    }`,
  )
  const finals: string[] = []
  let interim = ''
  let failed = false
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()))
  const words = () => [...finals, interim].filter(Boolean).join(' ')
  socket.addEventListener('error', () => {
    failed = true
  })
  socket.addEventListener('message', (event) => {
    let message: { type?: string; text?: string; final?: boolean }
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.type === 'error') failed = true
    if (message.type !== 'transcript') return
    if (message.final) {
      if (message.text) finals.push(message.text)
      interim = ''
    } else interim = message.text ?? ''
    onWords(words())
  })
  return {
    send(chunk: Blob) {
      if (socket.readyState === WebSocket.OPEN) socket.send(chunk)
    },
    // Sends everything recorded so far once connected (the first chunk carries the audio header).
    onOpen(send: () => void) {
      socket.addEventListener('open', send)
    },
    get ready() {
      return socket.readyState === WebSocket.OPEN
    },
    // Asks for the last words and waits for the server to close; null means "use the fallback".
    async finish() {
      if (failed || socket.readyState !== WebSocket.OPEN) {
        socket.close()
        return null
      }
      socket.send(JSON.stringify({ type: 'stop' }))
      const timedOut = await Promise.race([
        closed.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), finishTimeoutMs)),
      ])
      if (timedOut || failed) {
        socket.close()
        return null
      }
      return words().trim()
    },
    cancel() {
      socket.close()
    },
  }
}

export function DictationButton({
  threadId,
  onText,
  onPreview,
  onError,
  disabled = false,
}: {
  // The thread being dictated into, for its vocabulary.
  threadId?: string
  onText: (text: string) => void
  // The words so far while recording ('' when done), e.g. for the composer placeholder.
  onPreview?: (text: string) => void
  onError: (message: string) => void
  disabled?: boolean
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [seconds, setSeconds] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const cancelled = useRef(false)
  // Callbacks change on every render; read the latest when the recording finishes.
  const handlers = useRef({ onText, onPreview, onError })
  handlers.current = { onText, onPreview, onError }

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
    if (state === 'recording' && seconds >= maxSeconds) stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Every chunk is kept, so the fallback can still send the whole recording.
    const chunks: Blob[] = []
    const thread = vocabularyThread(threadId)
    const live = openStream((words) => {
      if (!cancelled.current) handlers.current.onPreview?.(words)
    }, thread)
    live.onOpen(() => chunks.forEach((chunk) => live.send(chunk)))
    media.ondataavailable = (event) => {
      if (!event.data.size) return
      chunks.push(event.data)
      if (live.ready) live.send(event.data)
    }
    media.onstop = async () => {
      release()
      if (cancelled.current) {
        live.cancel()
        return
      }
      const audio = new Blob(chunks, { type: media.mimeType || mimeType || 'audio/webm' })
      if (!audio.size) {
        live.cancel()
        handlers.current.onPreview?.('')
        setState('idle')
        return
      }
      setState('transcribing')
      try {
        const text = (await live.finish()) ?? (await transcribeRecording(audio, thread))
        if (cancelled.current) return
        if (text) handlers.current.onText(text)
        else handlers.current.onError('No speech was heard. Try again a bit closer to the mic.')
      } catch (error) {
        handlers.current.onError(error instanceof Error ? error.message : 'Dictation failed.')
      } finally {
        if (!cancelled.current) {
          handlers.current.onPreview?.('')
          setState('idle')
        }
      }
    }
    recorder.current = media
    cancelled.current = false
    setSeconds(0)
    cue('start')
    media.start(chunkMs)
    setState('recording')
  }
  function stop() {
    if (recorder.current?.state !== 'recording') return
    cue('stop')
    recorder.current.stop()
  }

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
