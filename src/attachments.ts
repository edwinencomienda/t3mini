// Client helpers for attaching images and turning dropped files into paths.
export type PendingAttachment = {
  key: string
  name: string
  previewUrl: string
  status: 'uploading' | 'ready'
  id?: string
}
export const imageMimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const isAttachableImage = (file: File) => imageMimeTypes.includes(file.type)

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
