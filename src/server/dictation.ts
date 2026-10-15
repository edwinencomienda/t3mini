import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

// Dictation: the browser records audio and posts it here; the server sends it to Deepgram.
// The API key comes from DEEPGRAM_API_KEY (takes priority) or from Settings, which saves it in
// .data/secrets.json (owner-only). The key never goes back to the browser.

export const maxAudioBytes = 15 * 1024 * 1024
// Containers browsers record with: Chrome/Firefox (webm/ogg + Opus), Safari (mp4 + AAC).
const audioTypes = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]

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
  mimeType: z.string().max(100),
  data: z.string().max(Math.ceil((maxAudioBytes * 4) / 3) + 4),
})

// The key saved from Settings, kept on globalThis so dev hot reloads don't lose it.
const globals = globalThis as typeof globalThis & { t3MiniDeepgramKey?: string }
const envKey = () => process.env.DEEPGRAM_API_KEY?.trim() || ''
const currentKey = () => envKey() || globals.t3MiniDeepgramKey || ''
export const dictationAvailable = () => Boolean(currentKey())
// For the live-dictation relay (server side only; never send it to the browser).
export const dictationKey = () => currentKey()

type Secrets = { deepgramApiKey?: string }
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
  globals.t3MiniDeepgramKey ??= (await readSecrets(path)).deepgramApiKey?.trim() || ''
}
// What Settings may show: never the key itself, only where it comes from and its last 4.
export function dictationStatus() {
  const key = currentKey()
  return {
    configured: Boolean(key),
    source: envKey() ? ('environment' as const) : key ? ('settings' as const) : null,
    hint: key ? key.slice(-4) : null,
  }
}
// Checks the key with Deepgram before saving, so a typo shows up now rather than mid-dictation.
export async function saveDictationKey(path: string, input: unknown, verify = true) {
  if (envKey())
    throw new DictationError(409, 'The key is set by DEEPGRAM_API_KEY; change it there instead.')
  const parsed = z
    .object({
      apiKey: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{20,128}$/),
    })
    .safeParse(input)
  if (!parsed.success) throw new DictationError(400, 'That doesn’t look like a Deepgram API key.')
  const { apiKey } = parsed.data
  if (verify) {
    let response: Response
    try {
      response = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new DictationError(502, 'Could not reach Deepgram to check the key.')
    }
    if (response.status === 401 || response.status === 403)
      throw new DictationError(400, 'Deepgram rejected this key.')
    if (!response.ok)
      throw new DictationError(502, `Deepgram could not check the key (${response.status}).`)
  }
  await writeSecrets(path, { ...(await readSecrets(path)), deepgramApiKey: apiKey })
  globals.t3MiniDeepgramKey = apiKey
  return dictationStatus()
}
export async function clearDictationKey(path: string) {
  const { deepgramApiKey: _removed, ...rest } = await readSecrets(path)
  await writeSecrets(path, rest)
  globals.t3MiniDeepgramKey = ''
  return dictationStatus()
}

export async function transcribe(input: unknown): Promise<{ text: string }> {
  const key = currentKey()
  if (!key)
    throw new DictationError(503, 'Dictation is not set up. Add a Deepgram key in Settings.')
  const { mimeType, data } = requestSchema.parse(input)
  // "audio/webm;codecs=opus" → "audio/webm"
  const container = mimeType.split(';')[0]!.trim().toLowerCase()
  if (!audioTypes.includes(container))
    throw new DictationError(400, 'This audio format is not supported for dictation.')
  const audio = Buffer.from(data, 'base64')
  if (!audio.length) throw new DictationError(400, 'The recording is empty.')
  if (audio.length > maxAudioBytes) throw new DictationError(413, 'The recording is too long.')
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || 'nova-3',
    smart_format: 'true',
    // Keep dictated content out of Deepgram's model-improvement program.
    mip_opt_out: 'true',
  })
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
