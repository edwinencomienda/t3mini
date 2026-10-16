import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ModelOption } from '../agent-settings'

// Creating a thread never waits for an agent's CLI to list its models (see models.ts).
const catalog = vi.hoisted(() => ({
  cached: undefined as ModelOption[] | undefined,
  load: (() => new Promise(() => {})) as () => Promise<ModelOption[]>,
}))
vi.mock('./models', async (original) => {
  const actual = await original<typeof import('./models')>()
  return {
    ...actual,
    cachedModels: () => catalog.cached,
    getModels: () => catalog.load(),
    warmModels: () => {},
  }
})
const { AgentService } = await import('./service')
const { ThreadStore } = await import('./store')

const opus: ModelOption = { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'] }
let directory: string
let service: InstanceType<typeof AgentService>
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-models-'))
  service = new AgentService(new ThreadStore(join(directory, 'threads.json')), {
    codex: async () => {},
    claude: async () => {},
  })
  catalog.cached = undefined
  catalog.load = () => new Promise(() => {})
})
afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})
const create = (effort: string) =>
  service.create({ provider: 'claude', cwd: directory, model: 'opus', effort })

it('creates right away while the model list is still loading', async () => {
  // getModels never answers here; creating must not wait for it.
  const thread = await create('medium')
  expect(thread.effort).toBe('medium')
})

it('checks against a list already in memory, without waiting', async () => {
  catalog.cached = [opus]
  expect((await create('high')).effort).toBe('high')
  await expect(create('max')).rejects.toThrow('not supported')
  await expect(
    service.create({ provider: 'claude', cwd: directory, model: '', effort: 'high' }),
  ).rejects.toThrow('Choose a model')
})

it('falls back to the default effort if the list, once loaded, doesn’t support it', async () => {
  let answer!: (models: ModelOption[]) => void
  catalog.load = () => new Promise((resolve) => (answer = resolve))
  const thread = await create('max')
  answer([opus])
  await vi.waitFor(() => expect(service.get(thread.id).effort).toBe(''))
})

it('keeps the effort when the CLI can’t answer', async () => {
  let fail!: (error: Error) => void
  catalog.load = () => new Promise((_, reject) => (fail = reject))
  const thread = await create('medium')
  fail(new Error('CLI missing'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(service.get(thread.id).effort).toBe('medium')
})
