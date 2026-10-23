import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
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
  const { copied, cloned } = await copyIncluded(repo, path).catch(() => ({
    copied: 0,
    cloned: [] as string[],
  }))
  // Leftovers from earlier removals (e.g. t3 mini quit mid-delete) go now, in the background.
  void emptyTrash()
  return {
    path,
    branch,
    base,
    repo,
    ...(subdir ? { subdir } : {}),
    setupMs: Math.round(performance.now() - started),
    ...(copied ? { copied } : {}),
    ...(cloned.length ? { cloned } : {}),
  }
}

// .worktreeinclude (gitignore syntax, as in Claude Code and Codex): files to copy into a new
// worktree, such as .env. Only files that are also gitignored are copied, so tracked files are
// never duplicated; symlinks are skipped and nothing is overwritten. A whole ignored folder
// listed there (node_modules/, .venv/) is cloned in one go where the disk supports it (APFS on
// macOS: copy-on-write, so it takes no extra space and the worktree's copy is independent), so a
// new worktree has its dependencies ready. Single files are copied, at most 1,000 in all.
const maxCopied = 1000
export async function copyIncluded(repo: string, worktree: string) {
  const list = join(repo, '.worktreeinclude')
  if (!(await stat(list).catch(() => null))?.isFile()) return { copied: 0, cloned: [] }
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
  const cloned: string[] = []
  for (const path of wanted) {
    if (!isIgnored(path)) continue
    const inside = relative(repo, join(repo, path))
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue
    const source = join(repo, inside)
    const info = await lstat(source)
    if (info.isSymbolicLink()) continue
    const target = join(worktree, inside)
    // A whole folder: cloned as one where possible; otherwise copied file by file if it fits in
    // what's left of the limit, or skipped. Never half a folder (half a node_modules breaks).
    if (info.isDirectory()) {
      if (await cloneFolder(source, target)) cloned.push(path.replace(/\/$/, '') + '/')
      else {
        const files = await countFiles(source, maxCopied - copied)
        if (files === null) continue
        await cp(source, target, {
          recursive: true,
          force: false,
          errorOnExist: false,
          filter: async (from) => !(await lstat(from)).isSymbolicLink(),
        })
        copied += files
      }
      continue
    }
    if (copied >= maxCopied) continue
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { force: false, errorOnExist: false })
    copied++
  }
  return { copied, cloned }
}

// How many files a folder holds (symlinks not counted, nor followed), or null once there are more
// than `limit`, without walking the rest.
async function countFiles(folder: string, limit: number): Promise<number | null> {
  let count = 0
  const walk = async (dir: string): Promise<boolean> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!(await walk(join(dir, entry.name)))) return false
      } else if (entry.isFile() && ++count > limit) return false
    }
    return true
  }
  return (await walk(folder)) ? count : null
}

// Clones a folder copy-on-write. On macOS with Bun (the t3mini binary), one clonefile(2) call
// clones the whole tree at once (~0.3 s for a 33k-file node_modules); elsewhere on macOS,
// `cp -c` clones it file by file (slower, still no extra space). Returns false when cloning
// isn't possible here (other systems, other disks, the target already exists), so nothing is
// copied rather than a partial folder.
async function cloneFolder(source: string, target: string) {
  if (process.platform !== 'darwin') return false
  if (await lstat(target).catch(() => null)) return false
  await mkdir(dirname(target), { recursive: true })
  const clonefile = await systemClonefile()
  if (clonefile) return clonefile(source, target)
  try {
    await exec('/bin/cp', ['-c', '-R', '--', source, target], { timeout: 300_000 })
    return true
  } catch {
    await rm(target, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

// clonefile(2) through Bun's FFI, or null under Node (the dev server).
let clonefileCall: Promise<((source: string, target: string) => boolean) | null> | undefined
function systemClonefile() {
  clonefileCall ??= (async () => {
    if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return null
    try {
      // Built at runtime so other bundlers don't try to resolve Bun's module.
      const ffi = await import(/* @vite-ignore */ ['bun', 'ffi'].join(':'))
      const { symbols } = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
        clonefile: { args: ['ptr', 'ptr', 'u32'], returns: 'i32' },
      })
      const text = (value: string) => ffi.ptr(Buffer.from(`${value}\0`))
      return (source: string, target: string) =>
        symbols.clonefile(text(source), text(target), 0) === 0
    } catch {
      return null
    }
  })()
  return clonefileCall
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
// branch stays, so commits made there are never lost. The folder is moved into the trash at once
// and deleted in the background, so removing one with its own node_modules (tens of thousands
// of files, about a second to delete) doesn't hold anything up.
export async function removeWorktree(worktree: ThreadWorktree) {
  const root = await realpath(worktreesRoot()).catch(() => null)
  const path = await realpath(worktree.path).catch(() => null)
  if (root && path) {
    const inside = relative(root, path)
    if (
      !inside ||
      inside.startsWith('..') ||
      isAbsolute(inside) ||
      inside.split(sep)[0] === trashName
    )
      throw new WorktreeError('Refusing to remove a folder t3 mini didn’t create.')
    const trash = join(root, trashName)
    await mkdir(trash, { recursive: true, mode: 0o700 })
    const moved = join(trash, randomUUID())
    try {
      // Same disk (inside the worktrees folder), so this is a rename, not a copy.
      await rename(path, moved)
    } catch {
      // Couldn't move it: let git delete it in place, as before.
      await git(worktree.repo, ['worktree', 'remove', '--force', '--', path], 60_000)
      await rmdir(dirname(path)).catch(() => {})
      return
    }
    // Git sees its folder is gone and forgets the worktree (the branch stays).
    await git(worktree.repo, ['worktree', 'prune'], 10_000).catch(() => {})
    // The repository's folder too, once its last worktree is gone (only if empty).
    await rmdir(dirname(path)).catch(() => {})
    void rm(moved, { recursive: true, force: true }).catch(() => {})
    return
  }
  // Already gone: forget it in the repository too.
  await git(worktree.repo, ['worktree', 'prune'], 10_000).catch(() => {})
}

// Removed worktrees waiting to be deleted, inside the worktrees folder (same disk).
const trashName = '.trash'
// Deletes whatever is left in the trash (removals interrupted when t3 mini quit).
export async function emptyTrash() {
  const trash = join(worktreesRoot(), trashName)
  const entries = await readdir(trash).catch(() => [] as string[])
  await Promise.all(
    entries.map((entry) =>
      rm(join(trash, entry), { recursive: true, force: true }).catch(() => {}),
    ),
  )
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
