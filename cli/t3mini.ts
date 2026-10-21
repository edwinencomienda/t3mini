// The t3mini binary (bun build --compile, see cli/compile.ts): the production t3 mini in one file,
// with its page files embedded. It runs separately from the dev server in the repo:
//   production (t3mini)     port 4011, data in ~/.t3-mini/data
//   dev (bun run dev)       port 4016, data in the repo's .data
// `t3mini start` runs `t3mini serve` in the background and keeps its pid and log in ~/.t3-mini.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }

const version = packageJson.version
const home = process.env.T3_MINI_HOME || join(homedir(), '.t3-mini')
const dataDir = process.env.T3_MINI_DATA_DIR || join(home, 'data')
const pidFile = join(home, 't3mini.pid')
const logFile = join(home, 't3mini.log')
const installFile = join(home, 'install.json')
const envFile = join(home, '.env')

const [command = 'help', ...args] = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const port = Number(option('port') || process.env.PORT || 4011)
const url = `http://127.0.0.1:${port}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// Settings for the server (e.g. DEEPGRAM_API_KEY) from ~/.t3-mini/.env; the environment wins.
// (The binary is built without Bun's .env autoloading, so a stray .env in the folder it's
// started from is never read.)
function loadEnvFile() {
  let text = ''
  try {
    text = readFileSync(envFile, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][\w.]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match || line.trimStart().startsWith('#')) continue
    const value = match[2]!.replace(/^(['"])(.*)\1$/, '$2')
    process.env[match[1]!] ??= value
  }
}

// The server: the built app plus the embedded page files. Loaded only for `serve`, so the other
// commands start instantly.
async function serve() {
  loadEnvFile()
  process.env.PORT = String(port)
  process.env.T3_MINI_DATA_DIR = dataDir
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const [{ default: app }, { default: files }, { startAppServer }] = await Promise.all([
    import('../dist/server/server.js'),
    import('../dist/client-files.ts'),
    import('../app-server.mjs'),
  ])
  startAppServer({
    app,
    port,
    label: `t3 mini ${version}`,
    async staticFile(pathname: string) {
      const file = (files as Record<string, string>)[pathname]
      return file ? async () => Buffer.from(await Bun.file(file).arrayBuffer()) : null
    },
  })
}

// The background server, if it's still the one we started (a reused pid runs something else).
function runningPid() {
  let pid: number
  try {
    pid = Number(readFileSync(pidFile, 'utf8').trim())
  } catch {
    return null
  }
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const running = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    return running.includes('t3mini') && running.includes(' serve') ? pid : null
  } catch {
    return null
  }
}
const answers = () =>
  fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(1500) })
    .then((response) => response.ok)
    .catch(() => false)

async function start() {
  if (runningPid()) return console.log(`t3 mini is already running → ${url}`)
  if (await answers()) fail(`Something else is already using port ${port}.`)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const log = openSync(logFile, 'a', 0o600)
  const child = spawn(process.execPath, ['serve', '--port', String(port)], {
    // Nothing depends on the working folder; home is a safe one.
    cwd: homedir(),
    detached: true,
    stdio: ['ignore', log, log],
  })
  closeSync(log)
  child.unref()
  await writeFile(pidFile, String(child.pid), { mode: 0o600 })
  for (let waited = 0; waited < 20_000; waited += 250) {
    if (await answers()) return console.log(`t3 mini ${version} is running → ${url}`)
    if (!runningPid()) break
    await sleep(250)
  }
  fail(`t3 mini didn’t start. See the log: ${logFile}`)
}

async function stop() {
  const pid = runningPid()
  if (!pid) {
    await rm(pidFile, { force: true })
    return console.log('t3 mini isn’t running.')
  }
  // SIGTERM lets it stop agent dev servers and phone access on its way out.
  process.kill(pid, 'SIGTERM')
  for (let waited = 0; waited < 10_000 && runningPid(); waited += 250) await sleep(250)
  if (runningPid()) process.kill(pid, 'SIGKILL')
  await rm(pidFile, { force: true })
  console.log('t3 mini stopped.')
}

async function status() {
  const pid = runningPid()
  console.log(pid ? `Running (pid ${pid}) → ${url}` : 'Not running.')
  console.log(`Version: ${version}`)
  console.log(`Binary:  ${process.execPath}`)
  console.log(`Data:    ${dataDir}`)
  console.log(`Log:     ${logFile}`)
  const install = await readFile(installFile, 'utf8').then(JSON.parse, () => null)
  if (install?.repo)
    console.log(`Source:  ${install.repo}${install.commit ? ` @ ${install.commit}` : ''}`)
}

async function logs() {
  const lines = Number(option('lines') || 100)
  const text = await readFile(logFile, 'utf8').catch(() => '')
  console.log(text.trimEnd().split('\n').slice(-lines).join('\n') || 'No log yet.')
}

function open() {
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], (error) => {
    if (error) console.log(url)
  })
}

// Updates t3mini. Installed from the repo (bun run install-cli): rebuilds from it. Otherwise (a
// release binary, e.g. from install.sh): downloads the newest release, or --version vX.Y.Z, checks
// its SHA256SUMS, and replaces this binary. Either way it restarts if running, unless an agent
// is working (--force: restart anyway). --release uses releases even with a repo.
async function update() {
  const install = await readFile(installFile, 'utf8').then(JSON.parse, () => null)
  const fromRepo =
    install?.repo && existsSync(join(install.repo, 'package.json')) && !args.includes('--release')
  if (fromRepo) {
    execFileSync('bun', ['run', 'install-cli', ...(args.includes('--force') ? ['--force'] : [])], {
      cwd: install.repo,
      stdio: 'inherit',
    })
    return
  }
  await updateFromRelease()
}

const releaseRepo = 'edwinencomienda/t3mini'
async function updateFromRelease() {
  const wanted = option('version')
  if (wanted && !/^v\d+\.\d+\.\d+$/.test(wanted)) fail('Versions look like v0.1.0.')
  let tag = wanted
  if (!tag) {
    const response = await fetch(`https://api.github.com/repos/${releaseRepo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 't3mini' },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null)
    tag = response?.ok ? ((await response.json()) as { tag_name?: string }).tag_name : undefined
    if (!tag) fail('Couldn’t find the latest release on GitHub.')
    if (tag === `v${version}`) return console.log(`t3mini ${version} is already the latest.`)
  }
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : ''
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : ''
  if (!os || !arch) fail(`No t3mini release for ${process.platform} ${process.arch}.`)
  const asset = `t3mini-${os}-${arch}`
  const base = `https://github.com/${releaseRepo}/releases/download/${tag}`
  console.log(`Downloading ${asset} ${tag}…`)
  const download = async (name: string) => {
    const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(300_000) }).catch(
      () => null,
    )
    if (!response?.ok) fail(`Couldn’t download ${base}/${name}.`)
    return Buffer.from(await response.arrayBuffer())
  }
  const [binary, sums] = await Promise.all([download(asset), download('SHA256SUMS')])
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === asset)?.[0]
  const { createHash } = await import('node:crypto')
  if (!expected || createHash('sha256').update(binary).digest('hex') !== expected)
    fail('The download didn’t match the release’s checksum; not installing it.')
  // Next to this binary, then renamed over it: the running server keeps its file until restart.
  const target = process.execPath
  const staged = join(dirname(target), '.t3mini.new')
  await writeFile(staged, binary, { mode: 0o755 })
  const { rename } = await import('node:fs/promises')
  await rename(staged, target)
  console.log(`Installed t3mini ${tag} → ${target}`)
  if (!runningPid()) return
  const busy = await busyThreads()
  if (busy.length && !args.includes('--force'))
    return console.log(
      `Not restarted: ${busy.length === 1 ? 'a thread is' : `${busy.length} threads are`} still running:\n` +
        busy.map((title) => `  - ${title}`).join('\n') +
        '\nRun `t3mini restart` when they finish, or `t3mini update --force` to restart now.',
    )
  // The new binary does the restart.
  execFileSync(target, ['restart', '--port', String(port)], { stdio: 'inherit' })
}
// Threads an agent is working on right now (an update's restart would stop them).
async function busyThreads() {
  try {
    const response = await fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(3000) })
    const bootstrap = (await response.json()) as { threads: { title: string; status: string }[] }
    return bootstrap.threads
      .filter((thread) => ['starting', 'working', 'waiting'].includes(thread.status))
      .map((thread) => thread.title)
  } catch {
    return []
  }
}

// Lets another computer add this one as a machine (docs/machines.md): turns on this t3 mini's
// gateway for other devices (Tailscale HTTPS, or --lan for the local network) and prints a
// one-time link (and QR) to paste into Settings → Machines → Add machine there. Starts t3mini
// first if needed. --json prints { link, expiresAt } for scripts.
async function pair() {
  const mode = args.includes('--lan') ? 'lan' : 'tailscale'
  const json = args.includes('--json')
  if (!(await answers())) {
    if (json) fail(`t3 mini isn’t running on port ${port}. Run t3mini start first.`)
    await start()
  }
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = (await response.json().catch(() => ({}))) as Record<string, any>
    if (!response.ok) fail(data.error || `t3 mini refused (${response.status}).`)
    return data
  }
  const status = await request('remote')
  if (!status.enabled || status.mode !== mode) await request('remote', { enabled: true, mode })
  const pairing = await request('remote/pair', {})
  const first = pairing.links?.[0]
  const link: string | undefined = typeof first === 'string' ? first : first?.url
  if (!link) fail('t3 mini didn’t return a pairing link.')
  if (json) return console.log(JSON.stringify({ link, expiresAt: pairing.expiresAt }))
  const { default: QRCode } = await import('qrcode')
  console.log(await QRCode.toString(link, { type: 'terminal', small: true }))
  console.log(`Add this machine from your other computer: Settings → Machines → Add machine, then paste:

  ${link}

It works once and expires in 5 minutes. Paired machines are listed (and can be removed) here in
Settings → Devices.`)
}

// Copies another t3 mini data folder (e.g. the repo's .data) in, only into an empty one.
async function importData() {
  const from = args[0]
  if (!from)
    fail('Usage: t3mini import <data folder>   e.g. t3mini import ~/projects/t3-mini/.data')
  if (!existsSync(join(from, 'threads.json'))) fail(`${from} doesn’t look like t3 mini data.`)
  if (runningPid()) fail('Stop t3 mini first (t3mini stop).')
  if ((await readdir(dataDir).catch(() => [])).length)
    fail(`${dataDir} already has data; not overwriting it.`)
  // Copied to the data folder itself, so an empty one (made by a first start) goes first.
  await rmdir(dataDir).catch(() => {})
  await mkdir(dirname(dataDir), { recursive: true, mode: 0o700 })
  await cp(from, dataDir, { recursive: true, errorOnExist: true, force: false })
  console.log(`Copied ${from} → ${dataDir}`)
}

const commands: Record<string, () => unknown> = {
  serve,
  start,
  stop,
  restart: async () => {
    await stop()
    await start()
  },
  status,
  logs,
  open,
  update,
  import: importData,
  pair,
  version: () => console.log(version),
}
const run = commands[command]
if (run) await run()
else {
  console.log(`t3mini ${version}: t3 mini in the background (production, port 4011)

  t3mini start [--port N]   start it and print its address
  t3mini stop | restart
  t3mini status             running? address, version, data folder, log
  t3mini open               open it in the browser
  t3mini logs [--lines N]   the end of its log
  t3mini update [--force]   update: rebuild from the repo it came from, or download the newest
                            release (--version vX.Y.Z, --release); restarts it unless a thread
                            is running (--force: restart anyway)
  t3mini import <folder>    copy another t3 mini data folder in (only into an empty one)
  t3mini pair [--lan]       a one-time link for adding this machine from another computer
                            (Settings → Machines); Tailscale by default, --lan: local network
  t3mini serve [--port N]   run in the foreground

Data: ${dataDir}   Settings: ${envFile} (e.g. DEEPGRAM_API_KEY=…)`)
  if (command !== 'help' && command !== '--help') process.exit(1)
}
