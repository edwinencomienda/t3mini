import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ModelOption } from '../agent-settings'
import type { Provider } from '../types'
import { openCodexClient } from './providers/codex-client'

const codexPage = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      displayName: z.string(),
      description: z.string().optional(),
      isDefault: z.boolean().optional(),
      defaultReasoningEffort: z.string().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).default([]),
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
      ...(process.env.CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CLAUDE_BIN } : {}),
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
const cache = new Map<string, { expires: number; result: Promise<ModelOption[]> }>()
export async function getModels(provider: Provider, path = homedir(), refresh = false) {
  const expanded =
    path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error('Use an absolute project folder path.')
  const cwd = await realpath(expanded)
  if (!(await stat(cwd)).isDirectory()) throw new Error('Project folder does not exist.')
  const key = JSON.stringify([provider, cwd])
  const previous = cache.get(key)
  if (!refresh && previous && previous.expires > Date.now()) return previous.result
  const result = (provider === 'codex' ? codexModels(cwd) : claudeModels(cwd)).catch(
    (error: unknown) => {
      cache.delete(key)
      throw error
    },
  )
  // Bound metadata cache size when browsing lots of projects.
  if (cache.size >= 32) cache.delete(cache.keys().next().value!)
  cache.set(key, { expires: Date.now() + 5 * 60_000, result })
  return result
}
export async function validateEffort(
  provider: Provider,
  cwd: string,
  settings: { model: string; effort: string },
) {
  if (!settings.effort) return
  if (!settings.model) throw new Error('Choose a model before selecting an effort level.')
  const models = await getModels(provider, cwd)
  if (!models.find((model) => model.id === settings.model)?.efforts.includes(settings.effort))
    throw new Error(
      'This effort level is not supported by the selected model. Use Default or choose a supported level.',
    )
}
