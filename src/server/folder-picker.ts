import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { HttpError } from './service'

const exec = promisify(execFile)
const inputSchema = z.object({ cwd: z.string().max(4096).default('') })
const script = `on run argv
  try
    set startingFolder to POSIX file (item 1 of argv) as alias
    set selectedFolder to choose folder with prompt "Choose a project folder for t3 mini" default location startingFolder
    return POSIX path of selectedFolder
  on error number -128
    return ""
  end try
end run`

async function nativeDialog(defaultLocation: string) {
  if (process.platform !== 'darwin')
    throw new HttpError(
      501,
      'The native folder chooser currently supports macOS. Enter the folder path manually.',
    )
  const { stdout } = await exec('/usr/bin/osascript', ['-e', script, defaultLocation], {
    timeout: 300_000,
  })
  return stdout.replace(/\r?\n$/, '')
}

let picking = false

// A native dialog returns the actual local path, which browser file inputs cannot expose.
export async function pickProjectFolder(input: unknown, dialog = nativeDialog) {
  const { cwd } = inputSchema.parse(input)
  if (picking)
    throw new HttpError(
      409,
      'A folder chooser is already open. Select a folder or cancel it first.',
    )
  picking = true
  try {
    const expanded =
      cwd === '~' ? homedir() : cwd.startsWith('~/') ? join(homedir(), cwd.slice(2)) : cwd
    const startingFolder =
      isAbsolute(expanded) && (await stat(expanded).catch(() => null))?.isDirectory()
        ? expanded
        : homedir()
    const selected = await dialog(startingFolder)
    if (!selected) return { path: null }
    const path = await realpath(selected)
    if (!(await stat(path)).isDirectory()) throw new Error('Not a folder')
    return { path }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(
      500,
      'Could not open the folder chooser. Try again or enter the folder path manually.',
    )
  } finally {
    picking = false
  }
}
