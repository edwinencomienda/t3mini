import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  clearDictationKey,
  dictationAvailable,
  dictationKey,
  dictationLive,
  dictationStatus,
  dictationToken,
  saveDictationKey,
  setDictationProvider,
  transcribe,
} from './dictation'

const fakeKey = 'test0000000000000000000000000000000abcd'
let directory: string
let secrets: string
const fetchMock = vi.fn()

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-dictation-'))
  secrets = join(directory, 'secrets.json')
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('DEEPGRAM_API_KEY', '')
  vi.stubEnv('ASSEMBLYAI_API_KEY', '')
  Object.assign(globalThis, {
    t3MiniDeepgramKey: '',
    t3MiniAssemblyKey: '',
    t3MiniDictationProvider: 'deepgram',
  })
})
afterEach(async () => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

it('checks the key with Deepgram, saves it owner-only, and only ever reports the last 4', async () => {
  expect(dictationAvailable()).toBe(false)
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
  await expect(saveDictationKey(secrets, { apiKey: fakeKey })).rejects.toThrow('rejected')
  await expect(saveDictationKey(secrets, { apiKey: 'short' })).rejects.toThrow()

  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
  const status = await saveDictationKey(secrets, { apiKey: fakeKey })
  expect(status).toMatchObject({ configured: true, source: 'settings', hint: 'abcd', live: true })
  expect(JSON.stringify(dictationStatus())).not.toContain(fakeKey.slice(0, 10))
  expect(fetchMock).toHaveBeenLastCalledWith(
    'https://api.deepgram.com/v1/projects',
    expect.objectContaining({ headers: { Authorization: `Token ${fakeKey}` } }),
  )
  expect(JSON.parse(await readFile(secrets, 'utf8'))).toEqual({ deepgramApiKey: fakeKey })
  expect((await stat(secrets)).mode & 0o777).toBe(0o600)

  expect(await clearDictationKey(secrets)).toMatchObject({
    configured: false,
    source: null,
    hint: null,
  })
  expect(JSON.parse(await readFile(secrets, 'utf8'))).toEqual({})
})
it('prefers DEEPGRAM_API_KEY and refuses to overwrite it from Settings', async () => {
  vi.stubEnv('DEEPGRAM_API_KEY', fakeKey)
  expect(dictationStatus()).toMatchObject({ configured: true, source: 'environment', hint: 'abcd' })
  await expect(saveDictationKey(secrets, { apiKey: fakeKey })).rejects.toThrow('DEEPGRAM_API_KEY')
})
it('sends audio to Deepgram and returns the transcript', async () => {
  vi.stubEnv('DEEPGRAM_API_KEY', fakeKey)
  fetchMock.mockResolvedValueOnce(
    Response.json({
      results: { channels: [{ alternatives: [{ transcript: ' Add a dark mode toggle. ' }] }] },
    }),
  )
  const audio = Buffer.from('fake audio bytes').toString('base64')
  expect(await transcribe({ mimeType: 'audio/webm;codecs=opus', data: audio })).toEqual({
    text: 'Add a dark mode toggle.',
  })
  const [url, init] = fetchMock.mock.calls[0]!
  expect(String(url)).toMatch(
    /^https:\/\/api\.deepgram\.com\/v1\/listen\?model=nova-3&smart_format=true&mip_opt_out=true$/,
  )
  expect(init.headers).toEqual({ Authorization: `Token ${fakeKey}`, 'Content-Type': 'audio/webm' })

  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
  await expect(transcribe({ mimeType: 'audio/mp4', data: audio })).rejects.toThrow('rejected')
  await expect(transcribe({ mimeType: 'text/html', data: audio })).rejects.toThrow('format')
})
it('reports dictation as not set up without a key', async () => {
  await expect(transcribe({ mimeType: 'audio/webm', data: 'AAAA' })).rejects.toThrow('not set up')
})
it('keeps an AssemblyAI key beside the Deepgram one and switches services', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
  await expect(
    saveDictationKey(secrets, { provider: 'assemblyai', apiKey: fakeKey }),
  ).rejects.toThrow('AssemblyAI rejected')
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
  await saveDictationKey(secrets, { provider: 'assemblyai', apiKey: fakeKey })
  expect(fetchMock).toHaveBeenLastCalledWith(
    'https://api.assemblyai.com/v2/transcript?limit=1',
    expect.objectContaining({ headers: { Authorization: fakeKey } }),
  )
  // Still Deepgram (no key): not available yet.
  expect(dictationAvailable()).toBe(false)
  const status = await setDictationProvider(secrets, { provider: 'assemblyai' })
  expect(status).toMatchObject({
    provider: 'assemblyai',
    configured: true,
    hint: 'abcd',
    live: false,
  })
  expect(status.keys.deepgram.configured).toBe(false)
  expect(JSON.stringify(status)).not.toContain(fakeKey.slice(0, 10))
  // No live relay with AssemblyAI: the recording is sent whole on stop.
  expect(dictationLive()).toBe(false)
  expect(dictationKey()).toBe('')
  expect(JSON.parse(await readFile(secrets, 'utf8'))).toEqual({
    assemblyaiApiKey: fakeKey,
    dictationProvider: 'assemblyai',
  })
  await expect(setDictationProvider(secrets, { provider: 'other' })).rejects.toThrow()
  expect((await clearDictationKey(secrets, { provider: 'assemblyai' })).configured).toBe(false)
})
it('sends a recording to AssemblyAI’s Dictation API in fast mode with the thread’s words', async () => {
  vi.stubEnv('ASSEMBLYAI_API_KEY', fakeKey)
  await setDictationProvider(secrets, { provider: 'assemblyai' })
  fetchMock.mockResolvedValueOnce(
    Response.json({ text: 'um add a dark mode toggle', llm_response: 'Add a dark mode toggle.' }),
  )
  const audio = Buffer.from('fake audio bytes').toString('base64')
  expect(
    await transcribe({ mimeType: 'audio/webm;codecs=opus', data: audio }, ['Tailwind', 'useTheme']),
  ).toEqual({ text: 'Add a dark mode toggle.' })
  const [url, init] = fetchMock.mock.calls[0]!
  expect(url).toBe('https://dictation.assemblyai.com/v1/transcribe')
  expect(init.headers).toEqual({ Authorization: fakeKey })
  const form = init.body as FormData
  expect(JSON.parse(await (form.get('config') as Blob).text())).toEqual({
    rewrite_mode: 'fast',
    keyterms_prompt: ['Tailwind', 'useTheme'],
  })
  expect((form.get('audio') as Blob).type).toBe('audio/webm')

  // The cleanup failed: the verbatim text.
  fetchMock.mockResolvedValueOnce(Response.json({ text: 'add a toggle', llm_response: null }))
  expect(await transcribe({ mimeType: 'audio/wav', data: audio })).toEqual({ text: 'add a toggle' })
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
  await expect(transcribe({ mimeType: 'audio/wav', data: audio })).rejects.toThrow(
    'AssemblyAI rejected',
  )
})
it('mints Dictation-only tokens for the phone, never handing out the key', async () => {
  await expect(dictationToken()).rejects.toThrow('isn’t using AssemblyAI')
  vi.stubEnv('ASSEMBLYAI_API_KEY', fakeKey)
  await setDictationProvider(secrets, { provider: 'assemblyai' })
  fetchMock.mockResolvedValueOnce(
    Response.json({ token: 'temporary-token', expires_in_seconds: 360 }),
  )
  const minted = await dictationToken(['Tailwind'], 1_000_000)
  expect(minted).toEqual({
    token: 'temporary-token',
    url: 'https://dictation.assemblyai.com/v1/transcribe',
    config: { rewrite_mode: 'fast', keyterms_prompt: ['Tailwind'] },
  })
  expect(JSON.stringify(minted)).not.toContain(fakeKey)
  const [url, init] = fetchMock.mock.calls[0]!
  expect(url).toBe('https://token.assemblyai.com/v1/token')
  expect(init.headers).toMatchObject({ Authorization: fakeKey })
  const off = { enabled: false }
  expect(JSON.parse(init.body)).toEqual({
    product: 'dictation',
    expires_in_seconds: 360,
    access: { streaming: off, sync: off, speech_to_speech: off, tts: off, llm_gateway: off },
  })
  // A few a minute at most.
  fetchMock.mockImplementation(async () => Response.json({ token: 't' }))
  for (let i = 1; i < 20; i++) await dictationToken([], 1_000_000 + i)
  await expect(dictationToken([], 1_000_030)).rejects.toThrow('Too many')
  expect((await dictationToken([], 1_100_000)).token).toBe('t')
})
