import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { deepgramParams, dictationKey, maxAudioBytes } from './dictation'
import { getService } from './service'

// Live dictation: the browser streams microphone audio over a WebSocket to this server, which
// relays it to Deepgram's streaming API and sends back only the transcript text. The Deepgram
// key stays on the server (it's sent to Deepgram in a header, never to the browser).
//
// Browser → server: binary audio chunks (MediaRecorder output), then {"type":"stop"}.
// Server → browser: {"type":"transcript","text","final"} and {"type":"error","message"}.

export const streamPath = '/api/dictation/stream'
// Matches the browser's 5-minute recording limit, plus time for Deepgram to finish.
const maxSessionMs = 5 * 60_000 + 30_000
const deepgramUrl = (keyterms: string[]) =>
  `wss://api.deepgram.com/v1/listen?${deepgramParams(keyterms, { interim_results: 'true' })}`

// Same rules as the HTTP API (checkRequest): loopback host and same origin only. Browsers always
// send Origin on WebSockets, so it's required. Paired phones reach it through the phone-access
// gateway, which has already authenticated them and rewritten Host/Origin to the app's own
// (a phone can only use the microphone over HTTPS, i.e. Tailscale).
export function allowedUpgrade(request: IncomingMessage) {
  const host = request.headers.host ?? ''
  let url: URL
  try {
    url = new URL(request.url ?? '/', `http://${host}`)
  } catch {
    return false
  }
  return (
    url.pathname === streamPath &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    request.headers.origin === `http://${host}`
  )
}

const server = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 })

export function handleDictationUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
  const refuse = (status: string) =>
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  if (!allowedUpgrade(request)) return refuse('403 Forbidden')
  const key = dictationKey()
  if (!key) return refuse('409 Conflict')
  // The browser only says which thread it's dictating into (?thread=…); the vocabulary is looked
  // up and filtered here, so the browser never chooses what is sent to Deepgram.
  const thread = new URL(request.url ?? '/', 'http://localhost').searchParams.get('thread')
  void (async () => {
    const keyterms =
      thread && /^[\w-]{1,100}$/.test(thread)
        ? await getService()
            .then((service) => service.dictationKeyterms(thread))
            .catch(() => [])
        : []
    server.handleUpgrade(request, socket, head, (client) => relay(client, key, keyterms))
  })()
}

function relay(client: WebSocket, key: string, keyterms: string[]) {
  const upstream = new WebSocket(deepgramUrl(keyterms), {
    headers: { Authorization: `Token ${key}` },
  })
  // Audio that arrives before Deepgram has accepted the connection.
  const pending: RawData[] = []
  let received = 0
  let stopping = false
  let done = false
  const tell = (message: object) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
  }
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    if (upstream.readyState === WebSocket.OPEN) upstream.close()
    else upstream.terminate()
    if (client.readyState === WebSocket.OPEN) client.close(1000)
  }
  const fail = (message: string) => {
    tell({ type: 'error', message })
    finish()
  }
  const timer = setTimeout(finish, maxSessionMs)
  // Deepgram sends its last results for the audio it has, then closes.
  const closeStream = () => upstream.send(JSON.stringify({ type: 'CloseStream' }))

  client.on('message', (data, isBinary) => {
    if (!isBinary) {
      let message: { type?: unknown }
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (message.type !== 'stop' || stopping) return
      stopping = true
      if (upstream.readyState === WebSocket.OPEN) closeStream()
      return
    }
    received += Buffer.isBuffer(data) ? data.length : 0
    if (received > maxAudioBytes) return fail('The recording is too long.')
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
    else pending.push(data)
  })
  client.on('close', finish)
  client.on('error', finish)

  upstream.on('open', () => {
    for (const chunk of pending.splice(0)) upstream.send(chunk)
    if (stopping) closeStream()
  })
  upstream.on('message', (data) => {
    let message: {
      type?: string
      is_final?: boolean
      channel?: { alternatives?: { transcript?: string }[] }
    }
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (message.type !== 'Results') return
    tell({
      type: 'transcript',
      text: message.channel?.alternatives?.[0]?.transcript ?? '',
      final: Boolean(message.is_final),
    })
  })
  // Deepgram refused the connection: say why without passing its response along.
  upstream.on('unexpected-response', (_request, response) =>
    fail(
      response.statusCode === 401 || response.statusCode === 403
        ? 'Deepgram rejected the API key. Check it in Settings → Dictation.'
        : `Deepgram is unavailable right now (HTTP ${response.statusCode}).`,
    ),
  )
  upstream.on('error', () => fail('Could not reach Deepgram. Check your internet connection.'))
  upstream.on('close', finish)
}

// The HTTP servers (Vite in dev, server.mjs in production) hand WebSocket upgrades to whatever
// this module registered last, so a dev hot reload swaps in the new code.
const globals = globalThis as typeof globalThis & {
  t3MiniDictationUpgrade?: typeof handleDictationUpgrade
}
export function registerDictationStream() {
  globals.t3MiniDictationUpgrade = handleDictationUpgrade
}
