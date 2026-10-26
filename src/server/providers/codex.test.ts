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
    cwd: thread.cwd,
    prompt,
    images: [],
    tools: {
      cwd: process.cwd(),
      attach: vi.fn(),
      saveImage: vi.fn(),
      processes: {} as never,
      threads: {} as never,
      browser: {} as never,
      saveHtml: async () => ({ id: 'x.html' }),
      renderHtml: vi.fn(),
      showHtml: vi.fn(),
      saveMedia: async () => ({ id: 'x.mp4' }),
      readThread: async () => '',
      setTodos: vi.fn(),
      showStatus: vi.fn(),
      ask: vi.fn(),
      rename: vi.fn(),
    },
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
it('declares t3 mini tools when a thread starts, and not again on resume', async () => {
  const fresh = context('settings')
  await runCodex(fresh)
  const started = JSON.parse(
    vi.mocked(fresh.text).mock.calls.find((call) => call[0] === 'settings')![1],
  )
  expect(started.thread.dynamicTools.map((tool: { name: string }) => tool.name)).toEqual([
    'show_image',
    'show_diagram',
    'show_html',
    'show_video',
    'play_audio',
    'update_checklist',
    'show_status',
    'ask_user',
    'rename_thread',
    'read_thread',
    'start_thread',
    'message_thread',
    'list_threads',
    'stop_thread',
    'delete_thread',
    'start_process',
    'list_processes',
    'process_logs',
    'stop_process',
    'restart_process',
    'browser_open',
    'browser_check',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_scroll',
    'browser_screenshot',
    'browser_wait_for',
    'browser_set_cookie',
    'browser_tabs',
    'browser_console',
    'browser_resize',
    'browser_theme',
    'browser_close',
  ])
  expect(started.thread.dynamicTools).toContainEqual(
    expect.objectContaining({
      type: 'function',
      name: 'show_image',
      inputSchema: expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({ path: expect.objectContaining({ type: 'string' }) }),
        required: ['path'],
      }),
    }),
  )
  const resumed = context('settings')
  resumed.thread.sessionId = 'previous-session'
  await runCodex(resumed)
  const wire = JSON.parse(
    vi.mocked(resumed.text).mock.calls.find((call) => call[0] === 'settings')![1],
  )
  expect(wire.thread).not.toHaveProperty('dynamicTools')
})
it('answers item/tool/call by running the tool, and reports refusals as failures', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 't3-mini-codex-tool-'))
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
  await writeFile(join(dir, 'shot.png'), png)
  const reply = async (prompt: string) => {
    const ctx = context(prompt)
    ctx.tools = {
      cwd: dir,
      attach: vi.fn(),
      saveImage: vi.fn(async () => ({ id: 'saved.png' })),
      processes: {} as never,
      threads: {} as never,
      browser: {} as never,
      saveHtml: async () => ({ id: 'x.html' }),
      renderHtml: vi.fn(),
      showHtml: vi.fn(),
      saveMedia: async () => ({ id: 'x.mp4' }),
      readThread: async () => '',
      setTodos: vi.fn(),
      showStatus: vi.fn(),
      ask: vi.fn(),
      rename: vi.fn(),
    }
    await runCodex(ctx)
    const result = JSON.parse(
      vi.mocked(ctx.text).mock.calls.find((call) => call[0] === 'tool-result')![1],
    )
    return { result, ctx }
  }
  try {
    const shown = await reply('tool:shot.png')
    expect(shown.result).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'Shown to the user: shot.png.' }],
    })
    expect(shown.ctx.tools.attach).toHaveBeenCalledWith({ type: 'image', id: 'saved.png' })
    const refused = await reply('tool:/etc/hosts')
    expect(refused.result.success).toBe(false)
    expect(refused.result.contentItems[0].text).toMatch('Only files inside')
    expect(refused.ctx.tools.attach).not.toHaveBeenCalled()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('labels Codex calls to t3 mini tools in the work log', async () => {
  const { describeCodexItem } = await import('./activity')
  expect(
    describeCodexItem(
      { type: 'dynamicToolCall', tool: 'show_image', arguments: { path: '/tmp/a.png' } },
      '/work',
    ),
  ).toMatchObject({ label: 'Show image', summary: 'a.png' })
  expect(
    describeCodexItem({ type: 'dynamicToolCall', tool: 'show_image', arguments: {} }, '/work'),
  ).toMatchObject({
    label: 'Show image',
    summary: undefined,
  })
})
it("shows images from Codex's built-in generator, reading files only from its own folder", async () => {
  const ctx = context('imagegen')
  ctx.tools = {
    cwd: process.cwd(),
    attach: vi.fn(),
    saveImage: vi.fn(async () => ({ id: 'gen.png' })),
    processes: {} as never,
    threads: {} as never,
    browser: {} as never,
    saveHtml: async () => ({ id: 'x.html' }),
    renderHtml: vi.fn(),
    showHtml: vi.fn(),
    saveMedia: async () => ({ id: 'x.mp4' }),
    readThread: async () => '',
    setTodos: vi.fn(),
    showStatus: vi.fn(),
    ask: vi.fn(),
    rename: vi.fn(),
  }
  await runCodex(ctx)
  expect(vi.mocked(ctx.tools.saveImage).mock.calls[0]![0].subarray(1, 4).toString()).toBe('PNG')
  expect(ctx.tools.attach).toHaveBeenCalledWith({
    type: 'image',
    id: 'gen.png',
    caption: 'A watercolor bird among spring blossoms',
  })
  const outside = context('imagegen:outside')
  outside.tools = {
    cwd: process.cwd(),
    attach: vi.fn(),
    saveImage: vi.fn(async () => ({ id: 'x.png' })),
    processes: {} as never,
    threads: {} as never,
    browser: {} as never,
    saveHtml: async () => ({ id: 'x.html' }),
    renderHtml: vi.fn(),
    showHtml: vi.fn(),
    saveMedia: async () => ({ id: 'x.mp4' }),
    readThread: async () => '',
    setTodos: vi.fn(),
    showStatus: vi.fn(),
    ask: vi.fn(),
    rename: vi.fn(),
  }
  await runCodex(outside)
  expect(outside.tools.saveImage).not.toHaveBeenCalled()
  expect(outside.tools.attach).not.toHaveBeenCalled()
})
