import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Attachment } from '../types'

// Images go to the agent as image input; other files are saved so the agent can read them by
// path. Everything lives in the private data directory with server-generated names.
export const imageTypes = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const
export type ImageType = keyof typeof imageTypes
const extensionTypes: Record<string, ImageType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
export const maxImageBytes = 10 * 1024 * 1024
export const maxFileBytes = 25 * 1024 * 1024
// Image ids are a UUID plus an image extension; nothing else is ever served back.
const imageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/
export const isImageId = (id: unknown): id is string => typeof id === 'string' && imageId.test(id)

export class UploadError extends Error {}

const uploadSchema = z.object({
  kind: z.enum(['image', 'file']),
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().max(255).default(''),
  data: z.string().max(Math.ceil((maxFileBytes * 4) / 3) + 4),
})
export const attachmentSchema = z.object({
  id: z.string().regex(imageId),
  name: z.string().trim().min(1).max(255),
})

// Check the file's real format from its first bytes; never trust the declared type alone.
function sniffImage(bytes: Buffer): ImageType | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  return null
}
// Keep a readable, filesystem-safe version of the original name for saved files.
const safeName = (name: string) =>
  name
    .replace(/[/\\]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(-80) || 'file'

// Videos and sounds the agent shows (show_video, play_audio). Like images, the real format is
// read from the file's first bytes, and the copy gets a generated name with that format's
// extension; it's only ever served back with that format's type (see mediaType).
export type MediaKind = 'video' | 'audio'
const mediaTypes = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
} as const
type MediaExtension = keyof typeof mediaTypes
export const maxVideoBytes = 200 * 1024 * 1024
export const maxAudioBytes = 50 * 1024 * 1024
const mediaId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm|mov|ogv|mp3|m4a|wav|oga|flac|weba)$/
export const mediaType = (id: string) => mediaTypes[id.split('.').pop() as MediaExtension]
// The file's format from its first bytes, or null when it isn't one browsers play.
export function sniffMedia(bytes: Buffer, kind: MediaKind): MediaExtension | null {
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString('ascii')
  // MP4 family: an "ftyp" box, whose brand says QuickTime or audio-only M4A.
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (kind === 'audio') return 'm4a'
    return brand === 'qt  ' ? 'mov' : 'mp4'
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return kind === 'video' ? 'webm' : 'weba'
  if (ascii(0, 4) === 'OggS') return kind === 'video' ? 'ogv' : 'oga'
  if (kind === 'video') return null
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav'
  if (ascii(0, 4) === 'fLaC') return 'flac'
  // MP3: an ID3 tag, or an MPEG audio frame (sync bits, layer III).
  if (ascii(0, 3) === 'ID3') return 'mp3'
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) === 0x02) return 'mp3'
  return null
}

export const maxHtmlBytes = 200 * 1024
const htmlId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html$/
export class Uploads {
  constructor(readonly directory: string) {}
  async save(input: unknown) {
    const { kind, name, data } = uploadSchema.parse(input)
    const bytes = Buffer.from(data, 'base64')
    if (!bytes.length) throw new UploadError('The file is empty.')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (kind === 'image') return { kind, name, ...(await this.saveImage(bytes)) }
    if (bytes.length > maxFileBytes) throw new UploadError('Files can be up to 25 MB.')
    // A UUID folder keeps the original file name readable for the agent without collisions.
    const folder = join(this.directory, 'files', crypto.randomUUID())
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const path = join(folder, safeName(name))
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    return { kind, path, name, size: bytes.length }
  }
  // Stores image bytes under a generated id after checking the real format from the bytes.
  // Used by uploads and by tools that show images (e.g. show_image).
  async saveImage(bytes: Buffer) {
    if (!bytes.length) throw new UploadError('The image is empty.')
    if (bytes.length > maxImageBytes) throw new UploadError('Images can be up to 10 MB.')
    const type = sniffImage(bytes)
    if (!type) throw new UploadError('Only PNG, JPEG, GIF, and WebP images can be shown.')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const id = `${crypto.randomUUID()}.${imageTypes[type]}`
    await writeFile(join(this.directory, id), bytes, { mode: 0o600, flag: 'wx' })
    return { id, mimeType: type, size: bytes.length }
  }
  // Resolves attachments sent with a message to saved images; unknown ids are rejected.
  async resolve(attachments: z.infer<typeof attachmentSchema>[]): Promise<Attachment[]> {
    return Promise.all(
      attachments.map(async ({ id, name }) => {
        const path = this.imagePath(id)
        try {
          if (!(await stat(path)).isFile()) throw new Error()
        } catch {
          throw new UploadError('An attached image is missing. Attach it again.')
        }
        return { id, name, mimeType: extensionTypes[id.split('.').pop()!]! }
      }),
    )
  }
  // Stores an agent's HTML page (show_html) under a generated id. It's only ever served as plain
  // text and shown inside a sandboxed frame (see HtmlView.tsx), never as a page of this site.
  async saveHtml(html: string) {
    const bytes = Buffer.from(html, 'utf8')
    if (!html.trim()) throw new UploadError('The HTML is empty.')
    if (bytes.length > maxHtmlBytes)
      throw new UploadError(`HTML can be up to ${maxHtmlBytes / 1024} KB. Keep it smaller.`)
    await mkdir(join(this.directory, 'html'), { recursive: true, mode: 0o700 })
    const id = `${crypto.randomUUID()}.html`
    await writeFile(join(this.directory, 'html', id), bytes, { mode: 0o600, flag: 'wx' })
    return { id }
  }
  async readHtml(id: string) {
    if (!htmlId.test(id)) throw new UploadError('Invalid page.')
    return readFile(join(this.directory, 'html', id), 'utf8')
  }
  // Copies a video or sound file (already checked to be an allowed file, see tools/paths.ts)
  // into the uploads. The copy is what's checked (format from its first bytes, and size), so
  // the original changing in between can't slip anything else in.
  async saveMedia(file: string, kind: MediaKind) {
    const folder = join(this.directory, 'media')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const name = crypto.randomUUID()
    const copy = join(folder, `${name}.tmp`)
    await copyFile(file, copy)
    try {
      const max = kind === 'video' ? maxVideoBytes : maxAudioBytes
      if ((await stat(copy)).size > max)
        throw new UploadError(`The file is too large (limit ${max / 1024 / 1024} MB).`)
      const handle = await open(copy, 'r')
      const head = Buffer.alloc(16)
      try {
        await handle.read(head, 0, 16, 0)
      } finally {
        await handle.close()
      }
      const extension = sniffMedia(head, kind)
      if (!extension)
        throw new UploadError(
          kind === 'video'
            ? 'Only MP4, WebM, MOV, and Ogg videos can be shown.'
            : 'Only MP3, M4A, WAV, Ogg, FLAC, and WebM audio can be played.',
        )
      const id = `${name}.${extension}`
      await rename(copy, join(folder, id))
      return { id }
    } catch (error) {
      await rm(copy, { force: true })
      throw error
    }
  }
  // Where a saved video or sound is (its id checked first), for streaming it.
  mediaPath(id: string) {
    if (!mediaId.test(id)) throw new UploadError('Invalid media.')
    return join(this.directory, 'media', id)
  }
  imagePath(id: string) {
    if (!imageId.test(id)) throw new UploadError('Invalid image.')
    return join(this.directory, id)
  }
  async read(id: string) {
    return {
      bytes: await readFile(this.imagePath(id)),
      mimeType: extensionTypes[id.split('.').pop()!]!,
    }
  }
}
