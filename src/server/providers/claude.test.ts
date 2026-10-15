import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { runClaude } from './claude'
import type { ProviderContext } from './types'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
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
        for await (const message of prompt) {
          expect(applied).toBe(true)
          inputs.push(message)
        }
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'native-session',
        } as SDKMessage
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
