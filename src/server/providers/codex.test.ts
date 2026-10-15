import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runCodex } from './codex'
import type { ProviderContext } from './types'
import type { Thread } from '../../types'

beforeEach(() => {
  vi.stubEnv('CODEX_BIN', fileURLToPath(new URL('../fixtures/codex.cjs', import.meta.url)))
})
afterEach(() => vi.unstubAllEnvs())
function context(prompt: string): ProviderContext {
  const thread: Thread = {
    id: 'thread',
    title: 'Test',
    provider: 'codex',
    model: '',
    effort: '',
    permissionMode: 'auto-accept-edits',
    cwd: process.cwd(),
    status: 'starting',
    messages: [],
    activities: [],
    approvals: [],
    createdAt: '',
    updatedAt: '',
  }
  return {
    thread,
    prompt,
    images: [],
    signal: new AbortController().signal,
    session: vi.fn((id) => {
      thread.sessionId = id
    }),
    text: vi.fn(),
    activity: vi.fn(),
    approve: vi.fn(async () => true),
  }
}
it('streams native deltas and completes only on turn/completed', async () => {
  const ctx = context('hello')
  await runCodex(ctx)
  expect(ctx.session).toHaveBeenCalledWith('native-thread')
  expect(ctx.text).toHaveBeenNthCalledWith(1, 'answer', 'Hello ')
  expect(ctx.text).toHaveBeenLastCalledWith('answer', 'Hello world.', true)
})
it('maps native permission requests to explicit approvals', async () => {
  const ctx = context('approval')
  await runCodex(ctx)
  expect(ctx.approve).toHaveBeenCalledWith({
    id: 'approval-1',
    title: 'Allow this command?',
    detail: 'git status',
  })
})
it('rejects if the provider exits before the completion event', async () => {
  await expect(runCodex(context('crash'))).rejects.toThrow('exited before completing')
})
it('cancels a running native process without waiting for output', async () => {
  const controller = new AbortController(),
    ctx = context('hang')
  ctx.signal = controller.signal
  ctx.session = () => controller.abort()
  await expect(runCodex(ctx)).rejects.toThrow()
})
it('reports a missing executable without hanging', async () => {
  vi.stubEnv('CODEX_BIN', '/does-not-exist/codex')
  await expect(runCodex(context('hello'))).rejects.toThrow('Could not start Codex')
})

it.each([
  ['approval-required', 'untrusted', 'readOnly', 'user'],
  ['auto-accept-edits', 'on-request', 'workspaceWrite', 'user'],
  ['auto', 'on-request', 'workspaceWrite', 'auto_review'],
  ['full-access', 'never', 'dangerFullAccess', 'user'],
] as const)(
  'sends %s permissions, selected model, and effort to the native turn',
  async (mode, approvalPolicy, sandbox, reviewer) => {
    const ctx = context('settings')
    ctx.thread.model = 'fixture-model'
    ctx.thread.effort = 'high'
    ctx.thread.permissionMode = mode
    await runCodex(ctx)
    const output = vi.mocked(ctx.text).mock.calls.find((call) => call[0] === 'settings')?.[1]
    const wire = JSON.parse(output!)
    expect(wire.turn).toMatchObject({
      model: 'fixture-model',
      effort: 'high',
      approvalPolicy,
      approvalsReviewer: reviewer,
      sandboxPolicy: { type: sandbox },
    })
  },
)
it('explicitly resets model and effort to current defaults on a resumed thread', async () => {
  const ctx = context('settings')
  ctx.thread.sessionId = 'previous-session'
  await runCodex(ctx)
  const wire = JSON.parse(vi.mocked(ctx.text).mock.calls.find((call) => call[0] === 'settings')![1])
  expect(wire.thread).toMatchObject({ threadId: 'previous-session', model: 'fixture-model' })
  expect(wire.turn).toMatchObject({ model: 'fixture-model', effort: 'medium' })
})
it('sends the selected service tier for the turn, and none for Standard', async () => {
  const fast = context('settings')
  fast.thread.model = 'fixture-model'
  fast.thread.serviceTier = 'fast'
  await runCodex(fast)
  const wire = JSON.parse(
    vi.mocked(fast.text).mock.calls.find((call) => call[0] === 'settings')![1],
  )
  expect(wire.turn.serviceTierForTurn).toBe('fast')
  const standard = context('settings')
  await runCodex(standard)
  const plain = JSON.parse(
    vi.mocked(standard.text).mock.calls.find((call) => call[0] === 'settings')![1],
  )
  expect(plain.turn).not.toHaveProperty('serviceTierForTurn')
})
it('lists model service tiers without the standard tier', async () => {
  const { readCodexModels } = await import('../models')
  const { openCodexClient } = await import('./codex-client')
  const client = openCodexClient({ cwd: process.cwd() })
  try {
    await client.initialize()
    const [model] = await readCodexModels(client)
    expect(model?.serviceTiers).toEqual([
      { id: 'fast', label: 'Fast', description: '2x speed, increased usage' },
    ])
  } finally {
    client.close()
  }
})
it('steers a message into the running turn with turn/steer', async () => {
  const ctx = context('hang')
  let steer!: Parameters<NonNullable<ProviderContext['onSteer']>>[0]
  ctx.onSteer = (handler) => {
    steer = handler
  }
  const run = runCodex(ctx)
  await vi.waitFor(() => expect(steer).toBeTypeOf('function'))
  expect(await steer({ prompt: 'Use TypeScript', images: [] })).toBe(true)
  await run
  const sent = JSON.parse(vi.mocked(ctx.text).mock.calls.find((call) => call[0] === 'steered')![1])
  expect(sent).toMatchObject({
    threadId: 'native-thread',
    expectedTurnId: 'turn-1',
    input: [{ type: 'text', text: 'Use TypeScript' }],
  })
  expect(await steer({ prompt: 'Too late', images: [] })).toBe(false)
})
