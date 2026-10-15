import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Opening a project in VS Code: the `code` CLI when it's on PATH (or VSCODE_BIN), otherwise
// the macOS app bundle via `open -a`. Commands run without a shell.
const exec = promisify(execFile)
const cli = () => process.env.VSCODE_BIN || 'code'
const appBundles = () => [
  '/Applications/Visual Studio Code.app',
  join(homedir(), 'Applications', 'Visual Studio Code.app'),
]

async function hasCli() {
  try {
    await exec(cli(), ['--version'], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}
async function findApp() {
  if (process.platform !== 'darwin') return null
  for (const path of appBundles())
    if (
      await stat(path).then(
        (info) => info.isDirectory(),
        () => false,
      )
    )
      return path
  return null
}

export async function vscodeAvailable() {
  return (await hasCli()) || Boolean(await findApp())
}

// `path` is a thread's project folder, already resolved to an absolute directory.
export async function openInVSCode(path: string) {
  if (await hasCli()) {
    await exec(cli(), [path], { timeout: 15_000 })
    return
  }
  const app = await findApp()
  if (!app) throw new Error('VS Code was not found on this machine.')
  await exec('open', ['-a', app, path], { timeout: 15_000 })
}
