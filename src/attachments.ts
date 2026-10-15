// Client helpers for attaching images and turning dropped files into paths.

// A random id that also works on plain-HTTP network addresses (phone access), where browsers
// don't provide crypto.randomUUID because the page isn't a secure context.
export const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

// Copies text, falling back to a temporary textarea where the Clipboard API isn't available
// (it needs a secure context, which phone access over HTTP isn't).
export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}
export type PendingAttachment = {
  key: string
  name: string
  previewUrl: string
  status: 'uploading' | 'ready'
  id?: string
}
export const imageMimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
// Any image the browser can decode is attached; formats the server doesn't take (HEIC from
// iPhones, AVIF, BMP…) are converted on the device first. SVG stays a file (it isn't a photo).
export const isAttachableImage = (file: File) =>
  (file.type.startsWith('image/') && file.type !== 'image/svg+xml') ||
  /\.(heic|heif)$/i.test(file.name)

// Keeps images within what agents accept and quick to upload from a phone: at most 2048px on
// the long side and about 4 MB (Claude rejects images over ~5 MB). Small PNG/JPEG/GIF/WebP files
// pass through untouched. Returns null when the browser can't decode the image.
const maxSide = 2048
const maxBytes = 4 * 1024 * 1024
export async function prepareImage(file: File): Promise<File | null> {
  if (imageMimeTypes.includes(file.type) && file.size <= maxBytes) return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const encode = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  // Screenshots stay PNG when that's small enough; photos become JPEG.
  let blob = file.type === 'image/png' ? await encode('image/png') : null
  if (!blob || blob.size > maxBytes) blob = await encode('image/jpeg', 0.85)
  if (!blob) return null
  const name = file.name.replace(/\.[^.]+$/, '') + (blob.type === 'image/png' ? '.png' : '.jpg')
  return new File([blob], name, { type: blob.type })
}

type Uploaded =
  | { kind: 'image'; id: string; name: string; mimeType: string }
  | { kind: 'file'; path: string; name: string }

function toBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '')
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.readAsDataURL(file)
  })
}
export async function uploadFile(file: File, kind: 'image' | 'file'): Promise<Uploaded> {
  const response = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      name: file.name,
      mimeType: file.type,
      data: await toBase64(file),
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Could not upload ${file.name}.`)
  return data as Uploaded
}

// Absolute paths from a drag that carries file:// URIs (editors, terminals). Finder drags in a
// browser never expose real paths, so those arrive as plain files instead.
export function droppedPaths(data: DataTransfer | null): string[] {
  const list = data?.getData('text/uri-list') || ''
  return list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('file://'))
    .map((uri) => {
      try {
        return decodeURIComponent(new URL(uri).pathname)
      } catch {
        return ''
      }
    })
    .filter(Boolean)
}
// Paths with spaces are quoted so the agent reads them as one argument.
export const formatPath = (path: string) => (/\s/.test(path) ? `"${path}"` : path)
export const basename = (path: string) => path.split('/').filter(Boolean).at(-1) || path
export const hasFiles = (data: DataTransfer | null) =>
  Boolean(data && [...data.types].some((type) => type === 'Files' || type === 'text/uri-list'))
