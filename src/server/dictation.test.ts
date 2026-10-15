import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  clearDictationKey,
  dictationAvailable,
  dictationStatus,
  saveDictationKey,
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
  ;(globalThis as { t3MiniDeepgramKey?: string }).t3MiniDeepgramKey = ''
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
  expect(status).toEqual({ configured: true, source: 'settings', hint: 'abcd' })
  expect(JSON.stringify(dictationStatus())).not.toContain(fakeKey.slice(0, 10))
  expect(fetchMock).toHaveBeenLastCalledWith(
    'https://api.deepgram.com/v1/projects',
    expect.objectContaining({ headers: { Authorization: `Token ${fakeKey}` } }),
  )
  expect(JSON.parse(await readFile(secrets, 'utf8'))).toEqual({ deepgramApiKey: fakeKey })
  expect((await stat(secrets)).mode & 0o777).toBe(0o600)

  expect(await clearDictationKey(secrets)).toEqual({ configured: false, source: null, hint: null })
  expect(JSON.parse(await readFile(secrets, 'utf8'))).toEqual({})
})
it('prefers DEEPGRAM_API_KEY and refuses to overwrite it from Settings', async () => {
  vi.stubEnv('DEEPGRAM_API_KEY', fakeKey)
  expect(dictationStatus()).toEqual({ configured: true, source: 'environment', hint: 'abcd' })
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
