import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'

// A project's own icon for its sidebar avatar: the first of a few well-known icon files
// inside the project (a favicon, an app icon, an extension icon). Only these names are read,
// only inside the project folder (symlinks pointing elsewhere are ignored), and only small
// image files. Projects without one get a letter avatar in the browser instead.

const candidates = [
  'public/favicon.svg',
  'public/icon.svg',
  'src/app/icon.svg',
  'app/icon.svg',
  'static/favicon.svg',
  'public/favicon.png',
  'public/icon.png',
  'public/apple-touch-icon.png',
  'src/app/icon.png',
  'app/icon.png',
  'static/favicon.png',
  'icons/icon128.png',
  'icons/icon-128.png',
  'public/logo.svg',
  'public/logo.png',
  'public/favicon.ico',
  'src/app/favicon.ico',
  'app/favicon.ico',
  'static/favicon.ico',
  'favicon.ico',
]
const types: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}
const maxBytes = 512 * 1024
const ttlMs = 10 * 60_000

type Found = { file: string; mimeType: string } | null

export class ProjectIcons {
  private cache = new Map<string, { at: number; found: Promise<Found>; value?: Found }>()
  constructor(private readonly onFound: () => void = () => {}) {}

  // Whether the project has an icon, if already known (looked up in the background otherwise;
  // onFound fires when one turns up).
  known(project: string): boolean | undefined {
    const entry = this.lookup(project)
    return entry.value === undefined ? undefined : Boolean(entry.value)
  }
  async read(project: string) {
    const found = await this.lookup(project).found
    if (!found) return undefined
    return { data: await readFile(found.file), mimeType: found.mimeType }
  }
  private lookup(project: string) {
    const cached = this.cache.get(project)
    if (cached && Date.now() - cached.at < ttlMs) return cached
    const entry: { at: number; found: Promise<Found>; value?: Found } = {
      at: Date.now(),
      found: find(project).catch(() => null),
    }
    void entry.found.then((value) => {
      entry.value = value
      if (value) this.onFound()
    })
    this.cache.set(project, entry)
    return entry
  }
}

async function find(project: string): Promise<Found> {
  const root = await realpath(project)
  for (const name of candidates) {
    try {
      const file = await realpath(join(root, name))
      if (!file.startsWith(root + sep)) continue
      const info = await stat(file)
      // Empty placeholders (Laravel ships a 0-byte favicon.ico) don't count.
      if (!info.isFile() || info.size < 32 || info.size > maxBytes) continue
      return { file, mimeType: types[extname(file).toLowerCase()]! }
    } catch {
      // Not there.
    }
  }
  return null
}
