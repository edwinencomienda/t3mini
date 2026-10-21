import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, realpath, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { ThreadWorktree } from '../types'

// Threads that run in their own git worktree: a second checkout of the project on its own branch
// (t3m/<id>), started from the project's current HEAD, in a folder t3 mini manages outside the
// repo (~/.t3-mini/worktrees/<repo>-<hash>/<id>). Commands run without a shell, with `--`
// before paths. See docs/worktrees.md.

const exec = promisify(execFile)
const git = async (cwd: string, args: string[], timeout = 30_000) =>
  (await exec('git', ['-C', cwd, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 })).stdout

export const worktreesRoot = () =>
  process.env.T3_MINI_WORKTREES_DIR || join(homedir(), '.t3-mini', 'worktrees')

export class WorktreeError extends Error {
  name = 'WorktreeError'
}
export const isWorktreeError = (error: unknown): error is WorktreeError =>
  error instanceof Error && error.name === 'WorktreeError'

// The top of the git repository a folder is in, or null when it isn't in one.
export async function repoRoot(folder: string) {
  try {
    return await realpath((await git(folder, ['rev-parse', '--show-toplevel'], 5_000)).trim())
  } catch {
    return null
  }
}

// The folder a worktree thread works in: the same spot inside the worktree as the project
// folder is inside its repository (usually the worktree's top).
export const worktreeFolder = (worktree: ThreadWorktree) =>
  worktree.subdir ? join(worktree.path, worktree.subdir) : worktree.path

export async function createWorktree(project: string, threadId: string): Promise<ThreadWorktree> {
  const started = performance.now()
  const repo = await repoRoot(project)
  if (!repo) throw new WorktreeError('Worktrees need a git repository; this project isn’t one.')
  const subdir = relative(repo, await realpath(project))
  let base: string
  try {
    base = (await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], 5_000)).trim()
  } catch {
    throw new WorktreeError('Worktrees start from the current commit; make a first commit.')
  }
  const short = threadId.replace(/-/g, '').slice(0, 8)
  const name =
    basename(repo)
      .replace(/[^\w.-]+/g, '-')
      .slice(0, 40) || 'repo'
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 6)
  const path = join(worktreesRoot(), `${name}-${hash}`, short)
  const branch = `t3m/${short}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await git(repo, ['worktree', 'add', '-b', branch, '--', path, base], 120_000)
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim().split('\n').at(-1)
    throw new WorktreeError(`Could not create the worktree${detail ? `: ${detail}` : '.'}`)
  }
  const copied = await copyIncluded(repo, path).catch(() => 0)
  return {
    path,
    branch,
    base,
    repo,
    ...(subdir ? { subdir } : {}),
    setupMs: Math.round(performance.now() - started),
    ...(copied ? { copied } : {}),
  }
}

// .worktreeinclude (gitignore syntax, as in Claude Code and Codex): files to copy into a new
// worktree, such as .env. Only files that are also gitignored are copied, so tracked files are
// never duplicated; symlinks are skipped and nothing is overwritten. Returns how many were copied.
const maxCopied = 1000
export async function copyIncluded(repo: string, worktree: string) {
  const list = join(repo, '.worktreeinclude')
  if (!(await stat(list).catch(() => null))?.isFile()) return 0
  const paths = async (args: string[]) =>
    (await git(repo, ['ls-files', '--others', '--ignored', '--directory', '-z', ...args]))
      .split('\0')
      .filter(Boolean)
  const [wanted, ignored] = await Promise.all([
    paths([`--exclude-from=${list}`]),
    paths(['--exclude-standard']),
  ])
  // An ignored folder ("node_modules/") covers everything inside it.
  const isIgnored = (path: string) =>
    ignored.some((entry) => entry === path || (entry.endsWith('/') && path.startsWith(entry)))
  let copied = 0
  for (const path of wanted) {
    if (copied >= maxCopied || !isIgnored(path)) continue
    const inside = relative(repo, join(repo, path))
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue
    const source = join(repo, inside)
    if ((await lstat(source)).isSymbolicLink()) continue
    await cp(source, join(worktree, inside), {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: async (from) => {
        if ((await lstat(from)).isSymbolicLink() || copied >= maxCopied) return false
        if ((await lstat(from)).isFile()) copied++
        return true
      },
    })
  }
  return copied
}

// Uncommitted changes in a worktree (edited, staged, or new files), or null when it's gone.
export async function worktreeChanges(worktree: ThreadWorktree) {
  if (!(await stat(worktree.path).catch(() => null))) return null
  try {
    const status = await git(worktree.path, ['status', '--porcelain', '-z'], 10_000)
    return status.split('\0').filter(Boolean).length
  } catch {
    return null
  }
}

// Removes a worktree folder t3 mini created (never anything outside its worktrees folder). The
// branch stays, so commits made there are never lost.
export async function removeWorktree(worktree: ThreadWorktree) {
  const root = await realpath(worktreesRoot()).catch(() => null)
  const path = await realpath(worktree.path).catch(() => null)
  if (root && path) {
    const inside = relative(root, path)
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      throw new WorktreeError('Refusing to remove a folder t3 mini didn’t create.')
    await git(worktree.repo, ['worktree', 'remove', '--force', '--', path], 60_000)
    // The repository's folder too, once its last worktree is gone (only if empty).
    await rmdir(dirname(path)).catch(() => {})
    return
  }
  // Already gone: forget it in the repository too.
  await git(worktree.repo, ['worktree', 'prune'], 10_000).catch(() => {})
}

// What a worktree holds now, for a helper's report: commits since it started and uncommitted
// changes. Null when it's gone or git can't tell.
export async function worktreeProgress(worktree: ThreadWorktree) {
  const changes = await worktreeChanges(worktree)
  if (changes === null) return null
  try {
    const commits = Number(
      (await git(worktree.path, ['rev-list', '--count', `${worktree.base}..HEAD`], 10_000)).trim(),
    )
    return { commits: Number.isFinite(commits) ? commits : 0, changes }
  } catch {
    return null
  }
}
