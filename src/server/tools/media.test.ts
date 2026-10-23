import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Block } from '../../blocks'
import { serveMedia } from '../api'
import { Uploads, sniffMedia } from '../uploads'
import { runTool } from './index'
import { playAudio } from './play-audio'
import { showVideo } from './show-video'
import type { ToolContext } from './types'

// The first bytes of each format, padded to a small file.
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypisom'), Buffer.alloc(64)])
const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(64)])
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)])
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)])
const mp3Frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(64)])
const wav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(64)])

it('recognizes media formats from their first bytes only', () => {
  expect(sniffMedia(mp4, 'video')).toBe('mp4')
  expect(sniffMedia(mov, 'video')).toBe('mov')
  expect(sniffMedia(webm, 'video')).toBe('webm')
  expect(sniffMedia(mp4, 'audio')).toBe('m4a')
  expect(sniffMedia(webm, 'audio')).toBe('weba')
  expect(sniffMedia(mp3, 'audio')).toBe('mp3')
  expect(sniffMedia(mp3Frame, 'audio')).toBe('mp3')
  expect(sniffMedia(wav, 'audio')).toBe('wav')
  expect(sniffMedia(Buffer.from('fLaC'), 'audio')).toBe('flac')
  // Audio-only formats aren't videos, and HTML or AAC frames aren't accepted at all.
  expect(sniffMedia(mp3, 'video')).toBeNull()
  expect(sniffMedia(Buffer.from('<html><script>'), 'video')).toBeNull()
  expect(sniffMedia(Buffer.from('<html><script>'), 'audio')).toBeNull()
  expect(sniffMedia(Buffer.from([0xff, 0xf1, 0x50, 0x80]), 'audio')).toBeNull()
})

const setup = async () => {
  const project = await mkdtemp(join(tmpdir(), 't3-mini-media-project-'))
  const uploads = new Uploads(await mkdtemp(join(tmpdir(), 't3-mini-media-uploads-')))
  const attach = vi.fn<(block: Block) => void>()
  const context: ToolContext = {
    cwd: project,
    attach,
    saveImage: vi.fn(),
    saveHtml: vi.fn(),
    saveMedia: (file, kind) => uploads.saveMedia(file, kind),
    readThread: async () => '',
    setTodos: vi.fn(),
    showStatus: vi.fn(),
    processes: {} as never,
    threads: {} as never,
    browser: {} as never,
    rename: vi.fn(),
  }
  return { project, uploads, attach, context }
}

it('shows a video and plays a sound, keeping a checked copy', async () => {
  const { project, uploads, attach, context } = await setup()
  await writeFile(join(project, 'demo.mp4'), mp4)
  await writeFile(join(project, 'hello.mp3'), mp3)
  expect(await runTool(showVideo, context, { path: 'demo.mp4', caption: 'Sign-up flow' })).toEqual({
    ok: true,
    text: 'Shown to the user: demo.mp4.',
  })
  const video = attach.mock.calls[0]![0] as Extract<Block, { type: 'video' }>
  expect(video).toEqual({
    type: 'video',
    id: expect.stringMatching(/\.mp4$/),
    caption: 'Sign-up flow',
  })
  expect((await runTool(playAudio, context, { path: 'hello.mp3' })).text).toMatch(
    /^Shown to the user: hello\.mp3\. It doesn't play on its own/,
  )
  expect(attach.mock.calls[1]![0]).toEqual({ type: 'audio', id: expect.stringMatching(/\.mp3$/) })
  // Older Codex threads still declare `autoplay`: it's accepted and ignored, nothing plays.
  expect(await runTool(playAudio, context, { path: 'hello.mp3', autoplay: true })).toMatchObject({
    ok: true,
  })
  expect(attach.mock.calls[2]![0]).toEqual({ type: 'audio', id: expect.stringMatching(/\.mp3$/) })
  // The copy is what gets served, under its generated name.
  expect(await readdir(join(uploads.directory, 'media'))).toHaveLength(3)
})

it('refuses files that are not media, and files outside the project or temp folders', async () => {
  const { project, uploads, attach, context } = await setup()
  await writeFile(join(project, 'page.mp4'), '<html><script>alert(1)</script></html>')
  expect(await runTool(showVideo, context, { path: 'page.mp4' })).toMatchObject({
    ok: false,
    text: expect.stringContaining('Only MP4, WebM, MOV, and Ogg videos'),
  })
  await writeFile(join(project, 'clip.mp4'), mp4)
  expect(await runTool(playAudio, context, { path: 'clip.mp4' })).toMatchObject({ ok: true })
  expect(await runTool(showVideo, context, { path: '/etc/hosts' })).toMatchObject({
    ok: false,
    text: expect.stringContaining('Only files inside the project folder'),
  })
  // The refused copy doesn't stay behind.
  expect(
    (await readdir(join(uploads.directory, 'media'))).some((name) => name.endsWith('.tmp')),
  ).toBe(false)
  expect(attach).toHaveBeenCalledTimes(1)
})

it('streams media whole or by byte range, with its own type and no sniffing', async () => {
  const { project, uploads, context } = await setup()
  const body = Buffer.concat([mp4, Buffer.from('0123456789')])
  await writeFile(join(project, 'demo.mp4'), body)
  const { id } = await context.saveMedia(join(project, 'demo.mp4'), 'video')
  const whole = await serveMedia(uploads, id, null)
  expect(whole.status).toBe(200)
  expect(whole.headers.get('content-type')).toBe('video/mp4')
  expect(whole.headers.get('accept-ranges')).toBe('bytes')
  expect(whole.headers.get('x-content-type-options')).toBe('nosniff')
  expect(Buffer.from(await whole.arrayBuffer())).toEqual(body)
  const part = await serveMedia(uploads, id, 'bytes=4-11')
  expect(part.status).toBe(206)
  expect(part.headers.get('content-range')).toBe(`bytes 4-11/${body.length}`)
  expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('ftypisom')
  const tail = await serveMedia(uploads, id, 'bytes=-10')
  expect(Buffer.from(await tail.arrayBuffer()).toString()).toBe('0123456789')
  const open = await serveMedia(uploads, id, `bytes=${body.length - 3}-`)
  expect(Buffer.from(await open.arrayBuffer()).toString()).toBe('789')
  expect((await serveMedia(uploads, id, `bytes=${body.length}-`)).status).toBe(416)
  // Only generated ids: no paths, no other files.
  expect((await serveMedia(uploads, '../media/x.mp4', null)).status).toBe(404)
  expect((await serveMedia(uploads, `${id.slice(0, -4)}.html`, null)).status).toBe(404)
})
