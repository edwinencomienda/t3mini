import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { ToolError } from './types'

// Resolves a file a tool was asked to read, allowing only files inside the thread's project
// folder or the system temp folders (where agents save screenshots). Symlinks are resolved
// first, so neither `../` nor a link can reach anything else on the machine.
export async function resolveAllowedFile(cwd: string, path: string, maxBytes: number) {
  const requested = isAbsolute(path) ? path : resolve(cwd, path)
  let real: string
  try {
    real = await realpath(requested)
  } catch {
    throw new ToolError(`File not found: ${path}`)
  }
  const roots = await Promise.all(
    [cwd, tmpdir(), '/tmp'].map((root) => realpath(root).catch(() => null)),
  )
  const inside = roots.some((root) => {
    if (!root) return false
    const offset = relative(root, real)
    return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset)
  })
  if (!inside)
    throw new ToolError('Only files inside the project folder or the temp folder can be shown.')
  const info = await stat(real)
  if (!info.isFile()) throw new ToolError(`Not a file: ${path}`)
  if (info.size > maxBytes)
    throw new ToolError(`The file is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB).`)
  return real
}
