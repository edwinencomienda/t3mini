import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

// request_secret (tools/request-secret.ts): the value you type goes straight into the project's
// env file here, and nowhere else. It's never returned to the agent, saved with the thread, sent
// in live updates or notifications, or logged; errors never include it.

const run = promisify(execFile)

// An environment variable name, as the agent asks for it.
export const secretNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
// .env, .env.local, .env.development.local…, and Wrangler's .dev.vars: files tools load secrets
// from and that are normally kept out of git.
const envFilePattern = /^(\.env(\.[A-Za-z0-9_-]{1,40}){0,3}|\.dev\.vars)$/
export const maxSecretLength = 16_384

export class SecretFileError extends Error {
  override name = 'SecretFileError'
}

/** The env file, checked: inside the project (links resolved first), and an env file by name. */
export async function secretFilePath(project: string, file: string) {
  const name = basename(file)
  if (!envFilePattern.test(name))
    throw new SecretFileError(
      'Secrets can only be saved to an env file such as .env or .env.local.',
    )
  if (isAbsolute(file) || file.split(/[\\/]/).includes('..'))
    throw new SecretFileError('The env file must be a path inside the project.')
  const root = await realpath(project)
  const target = resolve(root, file)
  // The folder must already be inside the project after resolving links.
  const folder = await realpath(dirname(target)).catch(() => {
    throw new SecretFileError('That folder doesn’t exist in the project.')
  })
  if (folder !== root && !folder.startsWith(root + sep))
    throw new SecretFileError('The env file must be inside the project.')
  const path = join(folder, name)
  // The file itself mustn't be a link (it could point anywhere).
  const info = await lstat(path).catch(() => null)
  if (info?.isSymbolicLink())
    throw new SecretFileError('The env file is a link; not writing to it.')
  if (info && !info.isFile()) throw new SecretFileError('That env file path isn’t a file.')
  return { root, path, relativePath: relative(root, path) }
}

/** `NAME=value`, quoted when the value needs it (spaces, #, quotes…), on one line. */
export function envLine(name: string, value: string) {
  if (/^[A-Za-z0-9_./:@+,=-]*$/.test(value)) return `${name}=${value}`
  return `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`
}

/** The file's text with NAME set to value: its line replaced, or added at the end. */
export function withSecret(text: string, name: string, value: string) {
  const line = envLine(name, value)
  const pattern = new RegExp(`^(export\\s+)?${name}\\s*=.*$`, 'm')
  if (pattern.test(text)) return text.replace(pattern, (_, exported = '') => exported + line)
  return text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n'
}

export function checkSecretValue(value: string) {
  if (!value) throw new SecretFileError('The value is empty.')
  if (value.length > maxSecretLength) throw new SecretFileError('The value is too long.')
  // One line: a newline would split it into a second variable.
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new SecretFileError('The value can’t contain line breaks or control characters.')
}

/** Whether git ignores the file; null outside a git repository. */
async function gitIgnores(root: string, path: string): Promise<boolean | null> {
  try {
    await run('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 })
  } catch {
    return null
  }
  try {
    await run('git', ['-C', root, 'check-ignore', '-q', '--', path], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * Writes NAME=value to the env file (created owner-only; an existing file keeps its other lines,
 * and is left owner-only too), and makes sure git ignores it: adds it to the project's .gitignore
 * when it isn't already. Refuses a file git already tracks (the secret would be committed).
 */
export async function saveSecret(project: string, file: string, name: string, value: string) {
  if (!secretNamePattern.test(name)) throw new SecretFileError('That isn’t a valid variable name.')
  checkSecretValue(value)
  const { root, path, relativePath } = await secretFilePath(project, file)
  // Already committed: writing a secret into it would put it in the next commit.
  const tracked = await run('git', ['-C', root, 'ls-files', '--error-unmatch', '--', path], {
    timeout: 5000,
  }).then(
    () => true,
    () => false,
  )
  if (tracked)
    throw new SecretFileError(
      `${relativePath} is tracked by git, so a secret in it would be committed. Use an ignored file such as .env.local.`,
    )
  let addedToGitignore = false
  if ((await gitIgnores(root, path)) === false) {
    const gitignore = join(root, '.gitignore')
    const current = await readFile(gitignore, 'utf8').catch(() => '')
    const entry = '/' + relativePath.split(sep).join('/')
    await writeFile(
      gitignore,
      current + (current && !current.endsWith('\n') ? '\n' : '') + entry + '\n',
    )
    addedToGitignore = true
  }
  const before = await readFile(path, 'utf8').catch(() => '')
  const existed = await stat(path).then(
    () => true,
    () => false,
  )
  await mkdir(dirname(path), { recursive: true })
  // Atomic: a temp file beside it (owner-only from the start), then renamed over it.
  const temp = `${path}.t3mini-${process.pid}-${Date.now()}.tmp`
  await writeFile(temp, withSecret(before, name, value), { mode: 0o600 })
  await rename(temp, path)
  await chmod(path, 0o600)
  return { file: relativePath, created: !existed, addedToGitignore }
}
