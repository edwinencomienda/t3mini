import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Provider } from '../types'

// Provider CLI updates. t3 mini runs the same `claude` and `codex` you use in the terminal, so
// upgrading them with their own `update` command is all it takes; the next turn uses the new
// version, and existing threads resume as before.

const exec = promisify(execFile)

// The installed Claude Code CLI: CLAUDE_BIN, else `claude` on PATH, else the native installer's
// ~/.local/bin (often missing from a server's PATH). Undefined means the copy bundled with the
// Agent SDK runs instead. Looked up each time, so a fresh install is picked up without a restart.
export function claudeExecutable(): string | undefined {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')]
  for (const dir of dirs) {
    if (!dir) continue
    const path = join(dir, 'claude')
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {
      /* Not here. */
    }
  }
  return undefined
}
export const providerExecutable = (provider: Provider) =>
  provider === 'codex' ? process.env.CODEX_BIN || 'codex' : claudeExecutable() || 'claude'

// Each CLI is published to npm under the same version numbers its own updater installs.
const packages: Record<Provider, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
}
const semver = /(\d+)\.(\d+)\.(\d+)/
export const parseVersion = (text: string) => semver.exec(text)?.[0] ?? null
// True when `latest` is newer than `installed` (pre-release tags are ignored).
export function isNewer(latest: string, installed: string) {
  const a = semver.exec(latest),
    b = semver.exec(installed)
  if (!a || !b) return false
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference) return difference > 0
  }
  return false
}

export type ProviderUpdate = {
  provider: Provider
  installed: string | null
  latest: string | null
  available: boolean
  updating: boolean
}
type State = {
  checkedAt: number
  latest: Partial<Record<Provider, string>>
  updating: Set<Provider>
}
// On globalThis so a dev hot reload keeps the cache and doesn't forget an update in progress.
const globals = globalThis as typeof globalThis & { t3MiniCliUpdates?: State }
const state = (globals.t3MiniCliUpdates ??= { checkedAt: 0, latest: {}, updating: new Set() })
const checkEvery = 6 * 60 * 60 * 1000
const providers: Provider[] = ['claude', 'codex']

async function installedVersion(provider: Provider) {
  try {
    const { stdout } = await exec(providerExecutable(provider), ['--version'], { timeout: 5_000 })
    return parseVersion(stdout)
  } catch {
    return null
  }
}
// A fixed, read-only lookup; a failure just means no update is offered.
async function latestVersion(provider: Provider) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packages[provider]}/latest`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const { version } = z.object({ version: z.string().max(64) }).parse(await response.json())
    return parseVersion(version) ?? undefined
  } catch {
    return undefined
  }
}

export async function providerUpdates(refresh = false): Promise<ProviderUpdate[]> {
  if (refresh || Date.now() - state.checkedAt > checkEvery) {
    const latest = await Promise.all(providers.map(latestVersion))
    providers.forEach((provider, index) => {
      if (latest[index]) state.latest[provider] = latest[index]
    })
    state.checkedAt = Date.now()
  }
  return Promise.all(
    providers.map(async (provider) => {
      const installed = await installedVersion(provider)
      const latest = state.latest[provider] ?? null
      return {
        provider,
        installed,
        latest,
        available: Boolean(installed && latest && isNewer(latest, installed)),
        updating: state.updating.has(provider),
      }
    }),
  )
}

export class UpdateError extends Error {
  readonly name = 'UpdateError'
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
const names: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }

// Runs the CLI's own updater (no shell, fixed arguments) and reports the version afterwards.
// `busy` refuses while a thread on this provider is running, so no turn sees the swap.
export async function updateProvider(provider: Provider, busy: boolean) {
  if (provider === 'claude' && !claudeExecutable())
    throw new UpdateError(409, 'The Claude Code CLI is not installed.')
  if (state.updating.has(provider))
    throw new UpdateError(409, `${names[provider]} is already updating.`)
  if (busy)
    throw new UpdateError(409, `A ${names[provider]} thread is running. Update once it finishes.`)
  state.updating.add(provider)
  try {
    await exec(providerExecutable(provider), ['update'], {
      timeout: 5 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch {
    // The updater's output can include local paths; keep it out of the response.
    throw new UpdateError(
      502,
      `${names[provider]} could not update. Try \`${provider} update\` in a terminal.`,
    )
  } finally {
    state.updating.delete(provider)
  }
  return (await providerUpdates()).find((item) => item.provider === provider)!
}
