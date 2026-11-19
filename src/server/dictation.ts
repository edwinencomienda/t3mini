import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { supportsKeyterms } from './keyterms'

// Dictation: the browser (or the phone) records audio and the server turns it into text with
// the service chosen in Settings:
// - Deepgram: live (words stream in while you talk, dictation-stream.ts) or a whole recording.
// - AssemblyAI's Dictation API: a whole recording, sent when you stop; it returns cleaned-up,
//   send-ready text (rewrite_mode "fast", the low-latency cleanup).
// Keys come from DEEPGRAM_API_KEY / ASSEMBLYAI_API_KEY (take priority) or from Settings, which
// saves them in .data/secrets.json (owner-only). Keys never go back to the browser.

export const maxAudioBytes = 15 * 1024 * 1024
// Containers browsers record with: Chrome/Firefox (webm/ogg + Opus), Safari (mp4 + AAC); the
// iPhone app sends WAV.
const audioTypes = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]

export const dictationProviders = ['deepgram', 'assemblyai'] as const
export type DictationProvider = (typeof dictationProviders)[number]
const providerNames: Record<DictationProvider, string> = {
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
}
const envNames: Record<DictationProvider, string> = {
  deepgram: 'DEEPGRAM_API_KEY',
  assemblyai: 'ASSEMBLYAI_API_KEY',
}

export class DictationError extends Error {
  readonly name = 'DictationError'
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const requestSchema = z.object({
  // The thread being dictated into, for its vocabulary (see keyterms.ts).
  thread: z.string().max(100).optional(),
  mimeType: z.string().max(100),
  data: z.string().max(Math.ceil((maxAudioBytes * 4) / 3) + 4),
})

// Keys and the chosen service from Settings, kept on globalThis so dev hot reloads keep them.
const globals = globalThis as typeof globalThis & {
  t3MiniDeepgramKey?: string
  t3MiniAssemblyKey?: string
  t3MiniDictationProvider?: DictationProvider
}
const envKey = (provider: DictationProvider) => process.env[envNames[provider]]?.trim() || ''
const savedKey = (provider: DictationProvider) =>
  (provider === 'deepgram' ? globals.t3MiniDeepgramKey : globals.t3MiniAssemblyKey) || ''
const keyFor = (provider: DictationProvider) => envKey(provider) || savedKey(provider)
export const activeProvider = (): DictationProvider => globals.t3MiniDictationProvider ?? 'deepgram'
export const dictationAvailable = () => Boolean(keyFor(activeProvider()))
// Whether words can stream in while you talk: Deepgram only (AssemblyAI's Dictation API takes
// the whole recording when you stop).
export const dictationLive = () => activeProvider() === 'deepgram' && dictationAvailable()
// For the live-dictation relay (server side only; never send it to the browser). Empty when
// AssemblyAI is chosen, so the relay refuses and the recording is sent whole instead.
export const dictationKey = () => (activeProvider() === 'deepgram' ? keyFor('deepgram') : '')

type Secrets = {
  deepgramApiKey?: string
  assemblyaiApiKey?: string
  dictationProvider?: DictationProvider
}
async function readSecrets(path: string): Promise<Secrets> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Secrets
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }
}
async function writeSecrets(path: string, secrets: Secrets) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path + '.tmp', JSON.stringify(secrets), { mode: 0o600 })
  await rename(path + '.tmp', path)
}
export async function loadDictationKey(path: string) {
  if (globals.t3MiniDeepgramKey !== undefined) return
  const secrets = await readSecrets(path)
  globals.t3MiniDeepgramKey = secrets.deepgramApiKey?.trim() || ''
  globals.t3MiniAssemblyKey = secrets.assemblyaiApiKey?.trim() || ''
  globals.t3MiniDictationProvider = dictationProviders.includes(
    secrets.dictationProvider as DictationProvider,
  )
    ? secrets.dictationProvider
    : 'deepgram'
}
const keyStatus = (provider: DictationProvider) => {
  const key = keyFor(provider)
  return {
    configured: Boolean(key),
    source: envKey(provider) ? ('environment' as const) : key ? ('settings' as const) : null,
    hint: key ? key.slice(-4) : null,
  }
}
// What Settings may show: never a key itself, only where it comes from and its last 4. The top
// fields are for the chosen service.
export function dictationStatus() {
  const provider = activeProvider()
  return {
    ...keyStatus(provider),
    provider,
    live: dictationLive(),
    keys: { deepgram: keyStatus('deepgram'), assemblyai: keyStatus('assemblyai') },
  }
}

// Checks a key with its service before saving, so a typo shows up now rather than mid-dictation.
export async function saveDictationKey(path: string, input: unknown, verify = true) {
  const parsed = z
    .object({
      provider: z.enum(dictationProviders).default('deepgram'),
      apiKey: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{20,128}$/),
    })
    .safeParse(input)
  const provider = (input as { provider?: DictationProvider } | null)?.provider ?? 'deepgram'
  const name = providerNames[dictationProviders.includes(provider) ? provider : 'deepgram']
  if (!parsed.success) throw new DictationError(400, `That doesn’t look like a ${name} API key.`)
  const { apiKey } = parsed.data
  if (envKey(parsed.data.provider))
    throw new DictationError(
      409,
      `The key is set by ${envNames[parsed.data.provider]}; change it there instead.`,
    )
  if (verify) await checkKey(parsed.data.provider, apiKey)
  const secrets = await readSecrets(path)
  if (parsed.data.provider === 'deepgram') {
    await writeSecrets(path, { ...secrets, deepgramApiKey: apiKey })
    globals.t3MiniDeepgramKey = apiKey
  } else {
    await writeSecrets(path, { ...secrets, assemblyaiApiKey: apiKey })
    globals.t3MiniAssemblyKey = apiKey
  }
  return dictationStatus()
}
async function checkKey(provider: DictationProvider, apiKey: string) {
  const name = providerNames[provider]
  let response: Response
  try {
    response =
      provider === 'deepgram'
        ? await fetch('https://api.deepgram.com/v1/projects', {
            headers: { Authorization: `Token ${apiKey}` },
            signal: AbortSignal.timeout(15_000),
          })
        : await fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
            headers: { Authorization: apiKey },
            signal: AbortSignal.timeout(15_000),
          })
  } catch {
    throw new DictationError(502, `Could not reach ${name} to check the key.`)
  }
  if (response.status === 401 || response.status === 403)
    throw new DictationError(400, `${name} rejected this key.`)
  if (!response.ok)
    throw new DictationError(502, `${name} could not check the key (${response.status}).`)
}
export async function clearDictationKey(path: string, input: unknown = {}) {
  const provider =
    z.object({ provider: z.enum(dictationProviders).default('deepgram') }).safeParse(input ?? {})
      .data?.provider ?? 'deepgram'
  const secrets = await readSecrets(path)
  if (provider === 'deepgram') {
    const { deepgramApiKey: _removed, ...rest } = secrets
    await writeSecrets(path, rest)
    globals.t3MiniDeepgramKey = ''
  } else {
    const { assemblyaiApiKey: _removed, ...rest } = secrets
    await writeSecrets(path, rest)
    globals.t3MiniAssemblyKey = ''
  }
  return dictationStatus()
}
// Which service dictation uses (Settings on the Mac).
export async function setDictationProvider(path: string, input: unknown) {
  const parsed = z.object({ provider: z.enum(dictationProviders) }).safeParse(input)
  if (!parsed.success) throw new DictationError(400, 'Choose Deepgram or AssemblyAI.')
  await writeSecrets(path, {
    ...(await readSecrets(path)),
    dictationProvider: parsed.data.provider,
  })
  globals.t3MiniDictationProvider = parsed.data.provider
  return dictationStatus()
}

// The thread a transcription request is for, if any (the server looks up its vocabulary).
export const transcriptionThread = (input: unknown) =>
  requestSchema.pick({ thread: true }).safeParse(input).data?.thread
// The Deepgram query for a dictation: model, formatting, privacy, and the thread's keyterms.
export function deepgramParams(keyterms: string[] = [], extra: Record<string, string> = {}) {
  const model = process.env.DEEPGRAM_MODEL || 'nova-3'
  const params = new URLSearchParams({
    model,
    smart_format: 'true',
    // Keep dictated content out of Deepgram's model-improvement program.
    mip_opt_out: 'true',
    ...extra,
  })
  if (supportsKeyterms(model)) for (const term of keyterms) params.append('keyterm', term)
  return params
}

export async function transcribe(
  input: unknown,
  keyterms: string[] = [],
): Promise<{ text: string }> {
  const provider = activeProvider()
  const key = keyFor(provider)
  if (!key)
    throw new DictationError(
      503,
      `Dictation is not set up. Add a ${providerNames[provider]} key in Settings.`,
    )
  const { mimeType, data } = requestSchema.parse(input)
  // "audio/webm;codecs=opus" → "audio/webm"
  const container = mimeType.split(';')[0]!.trim().toLowerCase()
  if (!audioTypes.includes(container))
    throw new DictationError(400, 'This audio format is not supported for dictation.')
  const audio = Buffer.from(data, 'base64')
  if (!audio.length) throw new DictationError(400, 'The recording is empty.')
  if (audio.length > maxAudioBytes) throw new DictationError(413, 'The recording is too long.')
  if (provider === 'assemblyai') return assemblyDictation(key, audio, container, keyterms)
  const params = deepgramParams(keyterms)
  let response: Response
  try {
    response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': container },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new DictationError(502, 'Could not reach Deepgram. Check your internet connection.')
  }
  if (response.status === 401 || response.status === 403)
    throw new DictationError(502, 'Deepgram rejected the API key. Update it in Settings.')
  if (response.status === 402)
    throw new DictationError(502, 'Your Deepgram account is out of credit.')
  if (!response.ok)
    throw new DictationError(502, `Deepgram could not transcribe this (${response.status}).`)
  const result = (await response.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] }
  }
  return { text: result.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '' }
}

// AssemblyAI's Dictation API: the whole recording in one request; back comes the verbatim
// transcript and a cleaned-up, send-ready version (rewrite_mode "fast": the low-latency cleanup).
// The thread's vocabulary goes as keyterms. Its text is used as plain text (never as HTML).
async function assemblyDictation(
  key: string,
  audio: Buffer,
  container: string,
  keyterms: string[],
): Promise<{ text: string }> {
  const config = {
    rewrite_mode: 'fast',
    ...(keyterms.length ? { keyterms_prompt: keyterms.slice(0, 100) } : {}),
  }
  const form = new FormData()
  form.append('config', new Blob([JSON.stringify(config)], { type: 'application/json' }))
  form.append(
    'audio',
    new Blob([new Uint8Array(audio)], {
      type: container === 'audio/x-wav' ? 'audio/wav' : container,
    }),
    'recording',
  )
  let response: Response
  try {
    response = await fetch('https://dictation.assemblyai.com/v1/transcribe', {
      method: 'POST',
      headers: { Authorization: key },
      body: form,
      signal: AbortSignal.timeout(90_000),
    })
  } catch {
    throw new DictationError(502, 'Could not reach AssemblyAI. Check your internet connection.')
  }
  if (response.status === 401 || response.status === 403)
    throw new DictationError(502, 'AssemblyAI rejected the API key. Update it in Settings.')
  if (response.status === 402)
    throw new DictationError(502, 'Your AssemblyAI account is out of credit.')
  if (response.status === 429 || response.status === 503)
    throw new DictationError(502, 'AssemblyAI is busy right now. Try again in a moment.')
  if (response.status === 400)
    throw new DictationError(
      400,
      'AssemblyAI couldn’t use this recording (too short or unreadable).',
    )
  if (!response.ok)
    throw new DictationError(502, `AssemblyAI could not transcribe this (${response.status}).`)
  const result = (await response.json()) as { text?: string; llm_response?: string | null }
  // The cleaned-up text, or the verbatim one when the cleanup didn't come back.
  return { text: (result.llm_response?.trim() || result.text?.trim()) ?? '' }
}

// The iPhone app sends AssemblyAI dictation straight from the phone (no trip through this Mac,
// which was slow over Tailscale/cellular): it asks here for a short-lived token that only works
// for the Dictation API (every other AssemblyAI product is switched off on it), plus the config
// to send. The API key itself never leaves the Mac. A few per minute at most.
const tokenLimit = { max: 20, windowMs: 60_000 }
const mintedAt: number[] = []
export const dictationDirect = () => activeProvider() === 'assemblyai' && dictationAvailable()

export async function dictationToken(keyterms: string[] = [], now = Date.now()) {
  const key = keyFor('assemblyai')
  if (activeProvider() !== 'assemblyai' || !key)
    throw new DictationError(409, 'Dictation isn’t using AssemblyAI.')
  while (mintedAt.length && now - mintedAt[0]! > tokenLimit.windowMs) mintedAt.shift()
  if (mintedAt.length >= tokenLimit.max)
    throw new DictationError(429, 'Too many dictations at once. Try again in a moment.')
  const off = { enabled: false }
  let response: Response
  try {
    response = await fetch('https://token.assemblyai.com/v1/token', {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: 'dictation',
        // Long enough for a five-minute recording to finish and be sent.
        expires_in_seconds: 360,
        access: { streaming: off, sync: off, speech_to_speech: off, tts: off, llm_gateway: off },
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new DictationError(502, 'Could not reach AssemblyAI.')
  }
  if (response.status === 401 || response.status === 403)
    throw new DictationError(502, 'AssemblyAI rejected the API key. Update it in Settings.')
  if (!response.ok)
    throw new DictationError(502, `AssemblyAI couldn’t start dictation (${response.status}).`)
  const minted = (await response.json()) as { token?: unknown }
  if (typeof minted.token !== 'string' || !minted.token)
    throw new DictationError(502, 'AssemblyAI didn’t return a token.')
  mintedAt.push(now)
  return {
    token: minted.token,
    url: 'https://dictation.assemblyai.com/v1/transcribe',
    config: {
      rewrite_mode: 'fast',
      ...(keyterms.length ? { keyterms_prompt: keyterms.slice(0, 100) } : {}),
    },
  }
}
