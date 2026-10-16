import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ModelOption } from '../agent-settings'
import type { Provider } from '../types'
import { openCodexClient } from './providers/codex-client'
import { claudeExecutableOption } from './providers/claude'

const codexPage = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      displayName: z.string(),
      description: z.string().optional(),
      isDefault: z.boolean().optional(),
      defaultReasoningEffort: z.string().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).default([]),
      serviceTiers: z
        .array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() }))
        .default([]),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
})
async function codexModels(cwd: string): Promise<ModelOption[]> {
  const client = openCodexClient({ cwd })
  try {
    await client.initialize()
    return await readCodexModels(client)
  } finally {
    client.close()
  }
}
export async function readCodexModels(
  client: Pick<ReturnType<typeof openCodexClient>, 'request'>,
): Promise<ModelOption[]> {
  const models: ModelOption[] = []
  let cursor: string | undefined
  do {
    const page = codexPage.parse(
      await client.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      }),
    )
    models.push(
      ...page.data.map((item) => ({
        id: item.model,
        label: item.displayName,
        description: item.description,
        isDefault: item.isDefault,
        defaultEffort: item.defaultReasoningEffort,
        efforts: item.supportedReasoningEfforts.map((option) => option.reasoningEffort),
        // "default"/"standard" is what an empty choice already means.
        serviceTiers: item.serviceTiers
          .filter((tier) => !['default', 'standard'].includes(tier.id))
          .map((tier) => ({ id: tier.id, label: tier.name, description: tier.description })),
      })),
    )
    cursor = page.nextCursor || undefined
  } while (cursor)
  return models
}
async function claudeModels(cwd: string): Promise<ModelOption[]> {
  const abortController = new AbortController()
  // Keep stdin open for initialization; no user prompt is submitted and no inference turn starts.
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }
  const stream = query({
    prompt: noPrompt(),
    options: {
      cwd,
      abortController,
      persistSession: false,
      settingSources: ['user', 'project', 'local'],
      ...claudeExecutableOption(),
    },
  })
  const timer = setTimeout(() => abortController.abort(), 20_000)
  try {
    return (await stream.supportedModels()).map((item) => ({
      id: item.value,
      label: item.displayName,
      description: item.description,
      efforts: item.supportedEffortLevels ?? [],
    }))
  } finally {
    clearTimeout(timer)
    abortController.abort()
    stream.close()
  }
}
// Model lists, per agent and project folder. Asking a CLI takes ~0.3 s (it starts a
// program), so lists are kept for an hour, and an older one is still answered right away while
// a fresh one loads in the background. t3 mini warms both agents' lists at startup.
type Entry = { fetchedAt: number; result: Promise<ModelOption[]>; value?: ModelOption[] }
const cache = new Map<string, Entry>()
const freshMs = 60 * 60_000
function load(provider: Provider, cwd: string, key: string) {
  const entry: Entry = {
    fetchedAt: Date.now(),
    result: (provider === 'codex' ? codexModels(cwd) : claudeModels(cwd)).then(
      (models) => {
        entry.value = models
        return models
      },
      (error: unknown) => {
        // Keep the last good list (if any) rather than nothing.
        if (cache.get(key) === entry) {
          if (previous?.value) cache.set(key, previous)
          else cache.delete(key)
        }
        throw error
      },
    ),
  }
  const previous = cache.get(key)
  // Bound metadata cache size when browsing lots of projects.
  if (!previous && cache.size >= 32) cache.delete(cache.keys().next().value!)
  cache.set(key, entry)
  return entry
}
export async function getModels(provider: Provider, path = homedir(), refresh = false) {
  const expanded =
    path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error('Use an absolute project folder path.')
  const cwd = await realpath(expanded)
  if (!(await stat(cwd)).isDirectory()) throw new Error('Project folder does not exist.')
  const key = JSON.stringify([provider, cwd])
  const previous = cache.get(key)
  if (refresh || !previous) return load(provider, cwd, key).result
  if (Date.now() - previous.fetchedAt > freshMs && previous.value) {
    // Stale: answer with what we have, refresh quietly.
    load(provider, cwd, key).result.catch(() => {})
    return previous.value
  }
  return previous.result
}
// A list already in memory, without waiting: this folder's, else this agent's most recent one
// for any folder (model lists are the same across projects in practice).
export function cachedModels(provider: Provider, cwd: string) {
  const exact = cache.get(JSON.stringify([provider, cwd]))?.value
  if (exact) return exact
  let latest: Entry | undefined
  for (const [key, entry] of cache)
    if (
      entry.value &&
      JSON.parse(key)[0] === provider &&
      (!latest || entry.fetchedAt > latest.fetchedAt)
    )
      latest = entry
  return latest?.value
}
// Loads both agents' lists ahead of time (at startup), so the first thread doesn't wait.
export function warmModels() {
  for (const provider of ['claude', 'codex'] as const) void getModels(provider).catch(() => {})
}
// The effort and tier checks against a model list (throws a message for the user).
export function checkEffort(
  models: ModelOption[],
  settings: { model: string; effort: string; serviceTier?: string },
) {
  const model = models.find((item) => item.id === settings.model)
  if (settings.effort && !model?.efforts.includes(settings.effort))
    throw new Error(
      'This effort level is not supported by the selected model. Use Default or choose a supported level.',
    )
  if (
    settings.serviceTier &&
    !model?.serviceTiers?.some((tier) => tier.id === settings.serviceTier)
  )
    throw new Error('This service tier is not available for the selected model. Use Standard.')
}
export async function validateEffort(
  provider: Provider,
  cwd: string,
  settings: { model: string; effort: string; serviceTier?: string },
) {
  if (!settings.effort && !settings.serviceTier) return
  if (!settings.model)
    throw new Error('Choose a model before selecting an effort level or service tier.')
  checkEffort(await getModels(provider, cwd), settings)
}
