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
      tools: {
        cwd: process.cwd(),
        attach: vi.fn(),
        saveImage: vi.fn(),
        processes: {} as never,
        browser: {} as never,
        saveHtml: async () => ({ id: 'x.html' }),
        saveMedia: async () => ({ id: 'x.mp4' }),
        rename: vi.fn(),
      },
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
    tools: {
      cwd: process.cwd(),
      attach: vi.fn(),
      saveImage: vi.fn(),
      processes: {} as never,
      browser: {} as never,
      saveHtml: async () => ({ id: 'x.html' }),
      saveMedia: async () => ({ id: 'x.mp4' }),
      rename: vi.fn(),
    },
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
    tools: {
      cwd: process.cwd(),
      attach: vi.fn(),
      saveImage: vi.fn(),
      processes: {} as never,
      browser: {} as never,
      saveHtml: async () => ({ id: 'x.html' }),
      saveMedia: async () => ({ id: 'x.mp4' }),
      rename: vi.fn(),
    },
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

it('asks questions, labels subagent steps, and reports background tasks', async () => {
  const question = {
    questions: [
      {
        question: 'How should v2 login handle 2FA users?',
        header: 'v2 login 2FA',
        multiSelect: false,
        options: [
          { label: 'Block 2FA users', description: 'Clear 403' },
          { label: 'Skip for now', description: 'Revisit later' },
        ],
      },
    ],
  }
  const decisions: unknown[] = []
  vi.mocked(query).mockImplementation(({ prompt, options }) => {
    async function* messages(): AsyncGenerator<SDKMessage> {
      if (typeof prompt === 'string') throw new Error('Expected streaming input')
      await prompt[Symbol.asyncIterator]().next()
      const canUseTool = options!.canUseTool!
      const signal = new AbortController().signal
      // Claude starts a background subagent…
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm1',
          content: [
            {
              type: 'tool_use',
              id: 'agent-1',
              name: 'Agent',
              input: { description: 'Update docs' },
            },
          ],
        },
      } as unknown as SDKMessage
      yield {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'agent-1',
        description: 'Update docs',
        is_backgrounded: true,
      } as unknown as SDKMessage
      // …whose own steps and words arrive tagged with that tool call.
      yield {
        type: 'assistant',
        parent_tool_use_id: 'agent-1',
        message: {
          id: 'm2',
          content: [
            { type: 'text', text: 'Subagent thinking out loud' },
            { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      } as unknown as SDKMessage
      // A question goes to the user even with full access; a skipped one is denied.
      decisions.push(
        await canUseTool('AskUserQuestion', question, { signal, toolUseID: 'q1' } as never),
      )
      decisions.push(
        await canUseTool('AskUserQuestion', question, { signal, toolUseID: 'q2' } as never),
      )
      yield {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'completed',
        output_file: '',
        summary: 'Docs updated',
      } as unknown as SDKMessage
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'native-session',
      } as SDKMessage
    }
    return Object.assign(messages(), {
      applyFlagSettings: vi.fn(async () => {}),
      close: vi.fn(),
    }) as unknown as ReturnType<typeof query>
  })
  const ask = vi
    .fn()
    .mockResolvedValueOnce({ 'How should v2 login handle 2FA users?': 'Block 2FA users' })
    .mockResolvedValueOnce(null)
  const ctx: ProviderContext = {
    thread: {
      id: 'thread',
      title: 'Test',
      provider: 'claude',
      cwd: process.cwd(),
      model: 'sonnet',
      effort: '',
      permissionMode: 'full-access',
      status: 'starting',
      createdAt: '',
      updatedAt: '',
      messages: [],
      activities: [],
      approvals: [],
    },
    prompt: 'Fix the API',
    images: [],
    tools: {
      cwd: process.cwd(),
      attach: vi.fn(),
      saveImage: vi.fn(),
      processes: {} as never,
      browser: {} as never,
      saveHtml: async () => ({ id: 'x.html' }),
      saveMedia: async () => ({ id: 'x.mp4' }),
      rename: vi.fn(),
    },
    signal: new AbortController().signal,
    session: vi.fn(),
    text: vi.fn(),
    activity: vi.fn(),
    approve: vi.fn(async () => true),
    ask,
    background: vi.fn(),
  }
  await runClaude(ctx)
  expect(ask).toHaveBeenCalledWith({
    id: 'q1',
    title: 'Claude has a question',
    questions: question.questions,
  })
  expect(decisions[0]).toEqual({
    behavior: 'allow',
    updatedInput: {
      ...question,
      answers: { 'How should v2 login handle 2FA users?': 'Block 2FA users' },
    },
  })
  expect(decisions[1]).toMatchObject({ behavior: 'deny' })
  expect(ctx.approve).not.toHaveBeenCalled()
  // The subagent's step is labelled; its words never become Claude's reply.
  expect(ctx.activity).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'bash-1', agent: 'Update docs' }),
  )
  expect(ctx.activity).toHaveBeenCalledWith(
    expect.not.objectContaining({ id: 'agent-1', agent: expect.anything() }),
  )
  expect(ctx.text).not.toHaveBeenCalled()
  expect(ctx.background).toHaveBeenNthCalledWith(1, [{ id: 'task-1', description: 'Update docs' }])
  expect(ctx.background).toHaveBeenLastCalledWith([])
})
