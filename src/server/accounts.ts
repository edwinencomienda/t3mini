import { homedir } from 'node:os'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Provider } from '../types'
import { openCodexClient } from './providers/codex-client'
import { claudeExecutableOption } from './providers/claude'

// Who each agent is signed in as, for Settings → Agents: the account's email and plan, as the
// agent itself reports them (Claude: the SDK's accountInfo(); Codex: app-server account/read).
// No AI call is made and no token is read; results are cached for five minutes.

export type ProviderAccount = {
  signedIn: boolean
  email?: string
  // e.g. "Claude Team", "ChatGPT Pro 5x", "API key".
  plan?: string
  // Why it couldn't be read (CLI missing, not responding…).
  error?: string
}

const ttlMs = 5 * 60_000
const timeoutMs = 20_000
const cache = new Map<Provider, { at: number; value: Promise<ProviderAccount> }>()

export function providerAccount(provider: Provider, refresh = false) {
  const cached = cache.get(provider)
  if (cached && !refresh && Date.now() - cached.at < ttlMs) return cached.value
  const value = (provider === 'claude' ? claudeAccount() : codexAccount()).catch(
    (): ProviderAccount => ({ signedIn: false, error: 'Couldn’t check the account.' }),
  )
  const entry = { at: Date.now(), value }
  cache.set(provider, entry)
  // Failures aren't kept: the next look tries again.
  void value.then((account) => {
    if (account.error && cache.get(provider) === entry) cache.delete(provider)
  })
  return value
}

async function claudeAccount(): Promise<ProviderAccount> {
  const abortController = new AbortController()
  // Keep stdin open for initialization; no prompt is sent and no inference turn starts.
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) =>
      abortController.signal.addEventListener('abort', () => resolve(), { once: true }),
    )
  }
  const stream = query({
    prompt: noPrompt(),
    options: {
      cwd: homedir(),
      abortController,
      persistSession: false,
      ...claudeExecutableOption(),
    },
  })
  const timer = setTimeout(() => abortController.abort(), timeoutMs)
  try {
    const info = await stream.accountInfo()
    const thirdParty = info.apiProvider && info.apiProvider !== 'firstParty'
    const plan =
      info.subscriptionType ||
      (info.apiKeySource ? 'API key' : thirdParty ? providerLabel(info.apiProvider!) : undefined)
    return {
      signedIn: Boolean(info.email || plan || info.tokenSource),
      ...(info.email ? { email: info.email } : {}),
      ...(plan ? { plan } : {}),
    }
  } finally {
    clearTimeout(timer)
    abortController.abort()
    stream.close()
  }
}
const providerLabel = (apiProvider: string) =>
  ({
    bedrock: 'Amazon Bedrock',
    vertex: 'Google Vertex AI',
    foundry: 'Microsoft Foundry',
    gateway: 'Enterprise gateway',
  })[apiProvider] ?? apiProvider

async function codexAccount(): Promise<ProviderAccount> {
  const client = openCodexClient({ cwd: homedir() })
  const timer = setTimeout(() => client.close(), timeoutMs)
  try {
    await client.initialize()
    const result = (await client.request('account/read', {})) as {
      account?: { type?: string; email?: string | null; planType?: string } | null
    }
    const account = result.account
    if (!account) return { signedIn: false }
    if (account.type === 'apiKey') return { signedIn: true, plan: 'OpenAI API key' }
    if (account.type === 'amazonBedrock') return { signedIn: true, plan: 'Amazon Bedrock' }
    return {
      signedIn: true,
      ...(account.email ? { email: account.email } : {}),
      ...(codexPlanLabel(account.planType) ? { plan: codexPlanLabel(account.planType) } : {}),
    }
  } finally {
    clearTimeout(timer)
    client.close()
  }
}

// Codex plan slugs as people know them (the same names t3code shows).
export function codexPlanLabel(planType: string | null | undefined) {
  switch (planType) {
    case 'free':
      return 'ChatGPT Free'
    case 'go':
      return 'ChatGPT Go'
    case 'plus':
      return 'ChatGPT Plus'
    case 'pro':
      return 'ChatGPT Pro 20x'
    case 'prolite':
      return 'ChatGPT Pro 5x'
    case 'promax':
      return 'ChatGPT Pro Max'
    case 'team':
      return 'ChatGPT Team'
    case 'business':
    case 'self_serve_business_prolite':
    case 'self_serve_business_usage_based':
      return 'ChatGPT Business'
    case 'enterprise':
    case 'ent26':
    case 'enterprise_cbp_automation':
    case 'enterprise_cbp_usage_based':
      return 'ChatGPT Enterprise'
    case 'edu':
    case 'edu_plus':
    case 'edu_pro':
      return 'ChatGPT Edu'
    case 'unknown':
      return 'ChatGPT'
    default:
      return undefined
  }
}
