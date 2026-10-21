// bun run install-cli: compiles the t3mini binary and installs it to ~/.local/bin (or
// T3_MINI_BIN_DIR), a copy that's separate from the repo. If t3mini is running, it restarts on
// the new version, unless an agent is working there (--force restarts anyway). `t3mini update`
// runs this again from the repo it remembers.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const root = join(import.meta.dir, '..')
const binDir = process.env.T3_MINI_BIN_DIR || join(homedir(), '.local', 'bin')
const home = process.env.T3_MINI_HOME || join(homedir(), '.t3-mini')
const target = join(binDir, 't3mini')

execFileSync('bun', ['run', 'compile'], { cwd: root, stdio: 'inherit' })

// Copy next to it, then rename: a running t3mini keeps its old file until it restarts.
mkdirSync(binDir, { recursive: true })
const staged = join(binDir, '.t3mini.new')
copyFileSync(join(root, 'dist', 'bin', 't3mini'), staged)
chmodSync(staged, 0o755)
renameSync(staged, target)

let commit: string | undefined
try {
  commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
} catch {
  commit = undefined
}
mkdirSync(home, { recursive: true, mode: 0o700 })
writeFileSync(
  join(home, 'install.json'),
  JSON.stringify({ repo: root, commit, installedAt: new Date().toISOString() }, null, 2),
  { mode: 0o600 },
)
console.log(`Installed t3mini → ${target}${commit ? ` (${commit})` : ''}`)

// Restart on the new version only if it's running, and not while an agent is working (that
// would stop its turn) unless --force. The new binary is in place either way; a running server
// keeps its old file until it restarts.
const status = (() => {
  try {
    return execFileSync(target, ['status'], { encoding: 'utf8' })
  } catch {
    return ''
  }
})()
const running = status.startsWith('Running')
const address = /→ (http:\/\/\S+)/.exec(status)?.[1]
let busy: string[] = []
if (running && address)
  try {
    const response = await fetch(`${address}/api/bootstrap`, { signal: AbortSignal.timeout(3000) })
    const bootstrap = (await response.json()) as { threads: { title: string; status: string }[] }
    busy = bootstrap.threads
      .filter((thread) => ['starting', 'working', 'waiting'].includes(thread.status))
      .map((thread) => thread.title)
  } catch {
    busy = []
  }
if (running && busy.length && !process.argv.includes('--force'))
  console.log(
    `\nNot restarted: ${busy.length === 1 ? 'a thread is' : `${busy.length} threads are`} still running in production:\n` +
      busy.map((title) => `  - ${title}`).join('\n') +
      '\nRun `t3mini restart` when they finish, or `t3mini update --force` to restart now (stops them).',
  )
else if (running) execFileSync(target, ['restart'], { stdio: 'inherit' })

if (!(process.env.PATH ?? '').split(delimiter).includes(binDir))
  console.log(
    `\n${binDir} isn’t on your PATH. Add this to your shell profile (e.g. ~/.zshrc):\n  export PATH="${binDir}:$PATH"`,
  )
else if (!running) console.log('Start it with: t3mini start')
