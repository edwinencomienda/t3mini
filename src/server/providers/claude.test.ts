import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { runClaude } from './claude'
import type { ProviderContext } from './types'

// Fake only query(); the real tool()/createSdkMcpServer() build t3 mini's tool server.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
}))
afterEach(() => vi.resetAllMocks())
it.each(['', 'low'] as const)(
  'applies effort %s before resuming and sending any prompt',
  async (effort) => {
    let applied = false
    const inputs: SDKUserMessage[] = []
    const applyFlagSettings = vi.fn(async () => {
      applied = true
    })
    const close = vi.fn()
    vi.mocked(query).mockImplementation(({ prompt }) => {
      async function* messages(): AsyncGenerator<SDKMessage> {
        if (typeof prompt === 'string') throw new Error('Expected streaming input')
        // Like the CLI: answer while the input is still open, then drain what remains.
        const input = prompt[Symbol.asyncIterator]()
        const first = await input.next()
        expect(applied).toBe(true)
        inputs.push(first.value)
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'native-session',
        } as SDKMessage
        for (let next = await input.next(); !next.done; next = await input.next())
          inputs.push(next.value)
      }
      return Object.assign(messages(), { applyFlagSettings, close }) as unknown as ReturnType<
        typeof query
      >
    })
    const ctx: ProviderContext = {
      thread: {
        id: 'thread',
        title: 'Test',
        provider: 'claude',
        cwd: process.cwd(),
        model: 'sonnet',
        effort,
        permissionMode: 'auto-accept-edits',
        status: 'starting',
        sessionId: 'native-session',
        createdAt: '',
        updatedAt: '',
        messages: [],
        activities: [],
        approvals: [],
      },
      prompt: 'Continue the conversation',
      images: [],
      tools: { cwd: process.cwd(), attach: vi.fn(), saveImage: vi.fn() },
      signal: new AbortController().signal,
      session: vi.fn(),
      text: vi.fn(),
      activity: vi.fn(),
      approve: vi.fn(async () => true),
    }
    await runClaude(ctx)
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: effort || null })
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: 'sonnet',
          resume: 'native-session',
          permissionMode: 'acceptEdits',
        }),
      }),
    )
    expect(inputs[0].message.content).toBe('Continue the conversation')
    expect(close).toHaveBeenCalled()
  },
)

it('steers messages into the running turn until its result, then stops accepting them', async () => {
  const inputs: SDKUserMessage[] = []
  let continueTurn!: () => void
  const steered = new Promise<void>((resolve) => {
    continueTurn = resolve
  })
  vi.mocked(query).mockImplementation(({ prompt }) => {
    async function* messages(): AsyncGenerator<SDKMessage> {
      if (typeof prompt === 'string') throw new Error('Expected streaming input')
      const input = prompt[Symbol.asyncIterator]()
      inputs.push((await input.next()).value)
      await steered
      inputs.push((await input.next()).value)
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'native-session',
      } as SDKMessage
      for (let next = await input.next(); !next.done; next = await input.next())
        inputs.push(next.value)
    }
    return Object.assign(messages(), {
      applyFlagSettings: vi.fn(async () => {}),
      close: vi.fn(),
    }) as unknown as ReturnType<typeof query>
  })
  let steer!: Parameters<NonNullable<ProviderContext['onSteer']>>[0]
  const ctx: ProviderContext = {
    thread: {
      id: 'thread',
      title: 'Test',
      provider: 'claude',
      cwd: process.cwd(),
      model: '',
      effort: '',
      permissionMode: 'full-access',
      status: 'starting',
      createdAt: '',
      updatedAt: '',
      messages: [],
      activities: [],
      approvals: [],
    },
    prompt: 'Build this',
    images: [],
    tools: { cwd: process.cwd(), attach: vi.fn(), saveImage: vi.fn() },
    signal: new AbortController().signal,
    session: vi.fn(),
    text: vi.fn(),
    activity: vi.fn(),
    approve: vi.fn(async () => true),
    onSteer: (handler) => {
      steer = handler
    },
  }
  const run = runClaude(ctx)
  await vi.waitFor(() => expect(inputs).toHaveLength(1))
  expect(await steer({ prompt: 'Use TypeScript', images: [] })).toBe(true)
  continueTurn()
  await run
  expect(inputs.map((input) => input.message.content)).toEqual(['Build this', 'Use TypeScript'])
  expect(inputs[1]?.priority).toBe('next')
  expect(await steer({ prompt: 'Too late', images: [] })).toBe(false)
})
it('gives Claude the t3 mini tools and runs display-only ones without asking', async () => {
  let options: Parameters<typeof query>[0]['options']
  vi.mocked(query).mockImplementation((params) => {
    options = params.options
    async function* messages(): AsyncGenerator<SDKMessage> {
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's' } as SDKMessage
    }
    return Object.assign(messages(), {
      applyFlagSettings: vi.fn(async () => {}),
      close: vi.fn(),
    }) as unknown as ReturnType<typeof query>
  })
  const approve = vi.fn(async () => false)
  const ctx = {
    thread: {
      id: 't',
      title: 'Test',
      provider: 'claude',
      cwd: process.cwd(),
      model: '',
      effort: '',
      permissionMode: 'approval-required',
      status: 'starting',
      createdAt: '',
      updatedAt: '',
      messages: [],
      activities: [],
      approvals: [],
    },
    prompt: 'Show me',
    images: [],
    tools: { cwd: process.cwd(), attach: vi.fn(), saveImage: vi.fn() },
    signal: new AbortController().signal,
    session: vi.fn(),
    text: vi.fn(),
    activity: vi.fn(),
    approve,
  } as ProviderContext
  await runClaude(ctx)
  expect(Object.keys(options!.mcpServers ?? {})).toEqual(['t3mini'])
  expect(options!.allowedTools).toContain('mcp__t3mini__show_image')
  const decision = await options!.canUseTool!('mcp__t3mini__show_image', { path: 'a.png' }, {
    toolUseID: 'x',
  } as never)
  expect(decision).toMatchObject({ behavior: 'allow' })
  expect(approve).not.toHaveBeenCalled()
})
