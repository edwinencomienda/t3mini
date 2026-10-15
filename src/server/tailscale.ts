import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

// Phone access over Tailscale: `tailscale serve` puts the phone-access gateway behind HTTPS on
// this Mac's tailnet name (e.g. https://macbook.tail1234.ts.net:8443). Tailnet only: this never
// uses Funnel, which would publish to the internet. Pairing still applies on top.
//
// The CLI runs without a shell, with argument arrays and timeouts (like editor.ts).

const exec = promisify(execFile)
const appCli = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

// The HTTPS port on the tailnet name (8443, like t3code; override with T3_MINI_TAILSCALE_PORT).
export const tailscalePort = () => Number(process.env.T3_MINI_TAILSCALE_PORT) || 8443

// TAILSCALE_BIN, else `tailscale` on PATH, else the CLI inside the macOS app.
function commands() {
  if (process.env.TAILSCALE_BIN) return [process.env.TAILSCALE_BIN]
  return existsSync(appCli) ? ['tailscale', appCli] : ['tailscale']
}
async function run(args: string[], timeout: number) {
  let missing: unknown
  for (const command of commands())
    try {
      return await exec(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missing = error
        continue
      }
      throw error
    }
  throw missing
}
const output = (error: unknown) => {
  const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
  return `${stdout}\n${stderr}`
}

export type TailscaleStatus = {
  // The CLI is installed.
  available: boolean
  // Signed in and connected, with a MagicDNS name to serve on.
  running: boolean
  // This Mac's tailnet name, e.g. "macbook.tail1234.ts.net".
  dnsName?: string
  // Why it can't be used yet, in words for Settings.
  problem?: string
}

export async function tailscaleStatus(): Promise<TailscaleStatus> {
  let text: string
  try {
    text = (await run(['status', '--json'], 5_000)).stdout
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { available: false, running: false, problem: 'Tailscale isn’t installed.' }
    // `status` exits non-zero when stopped but still prints its JSON.
    text = output(error)
  }
  let data: { BackendState?: string; Self?: { DNSName?: string } }
  try {
    data = JSON.parse(text.slice(text.indexOf('{')))
  } catch {
    return { available: true, running: false, problem: 'Tailscale didn’t respond.' }
  }
  if (data.BackendState !== 'Running')
    return {
      available: true,
      running: false,
      problem: 'Tailscale is not connected. Open Tailscale on this Mac and sign in.',
    }
  const dnsName = String(data.Self?.DNSName ?? '').replace(/\.$/, '')
  if (!dnsName)
    return {
      available: true,
      running: false,
      problem: 'Turn on MagicDNS for your tailnet in the Tailscale admin console.',
    }
  return { available: true, running: true, dnsName }
}

export class TailscaleError extends Error {
  readonly name = 'TailscaleError'
}

// Runs `tailscale serve` in its own process group and stops the whole group when it's done
// waiting: `tailscale` is often a wrapper script (/usr/local/bin/tailscale) that starts the real
// CLI without replacing itself, so killing only the wrapper would leave `serve` running. When the
// tailnet hasn't approved Serve/HTTPS yet, the CLI prints an approval link and waits; it's stopped
// as soon as the link appears, so nothing finishes serving later behind phone access's back.
function serveOnce(command: string, args: string[], timeout: number) {
  return new Promise<{ ok: boolean; output: string }>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const stop = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!ok) stop()
      resolve({ ok, output })
    }
    const timer = setTimeout(() => finish(false), timeout)
    const read = (chunk: Buffer) => {
      output += chunk
      if (approvalLink.test(output)) finish(false)
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('error', (error) => {
      clearTimeout(timer)
      settled = true
      reject(error)
    })
    child.on('exit', (code) => finish(code === 0))
  })
}
const approvalLink = /https:\/\/login\.tailscale\.com\/\S+/

// Serves http://127.0.0.1:<gatewayPort> at https://<dnsName>:<tailscalePort> on the tailnet.
export async function serveGateway(gatewayPort: number) {
  const args = ['serve', '--bg', `--https=${tailscalePort()}`, `http://127.0.0.1:${gatewayPort}`]
  let result: { ok: boolean; output: string } | undefined
  for (const command of commands())
    try {
      result = await serveOnce(command, args, 20_000)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  if (!result) throw new TailscaleError('Tailscale isn’t installed.')
  if (result.ok) return
  // e.g. "Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/…"
  const enable = result.output.match(approvalLink)?.[0]
  throw new TailscaleError(
    enable
      ? `Turn on HTTPS (Serve) for your tailnet first: ${enable}`
      : 'Tailscale could not serve t3 mini. Check that HTTPS certificates are enabled for your tailnet.',
  )
}

// Whether the serve config sends our HTTPS port to this gateway (and so is ours to remove).
export function servesGateway(config: unknown, gatewayPort: number) {
  const web = (
    config as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }
  )?.Web
  return Object.entries(web ?? {}).some(
    ([host, entry]) =>
      host.endsWith(`:${tailscalePort()}`) &&
      Object.values(entry.Handlers ?? {}).some((handler) =>
        /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/?$/.test(handler.Proxy ?? '')
          ? Number(handler.Proxy!.match(/:(\d+)\/?$/)![1]) === gatewayPort
          : false,
      ),
  )
}

// Removes our serve entry, and only ours: other things you serve are left alone.
export async function stopServingGateway(gatewayPort: number) {
  let config: unknown
  try {
    config = JSON.parse((await run(['serve', 'status', '--json'], 5_000)).stdout || '{}')
  } catch {
    return
  }
  if (servesGateway(config, gatewayPort))
    await run(['serve', `--https=${tailscalePort()}`, 'off'], 10_000).catch(() => {})
}

// The same, synchronously, for process exit (async work can't run there).
export function stopServingGatewayNow() {
  for (const command of commands())
    try {
      execFileSync(command, ['serve', `--https=${tailscalePort()}`, 'off'], {
        timeout: 3_000,
        stdio: 'ignore',
      })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
}
