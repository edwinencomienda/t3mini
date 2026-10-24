import { describe, expect, it } from 'vitest'
import type { Message, Thread } from '../types'
import { handoffRecap, switchAgent } from './handoff'

const message = (id: string, role: Message['role'], text: string, extra: Partial<Message> = {}) =>
  ({ id, role, text, createdAt: '2026-01-01T00:00:00.000Z', ...extra }) as Message

const base = (messages: Message[]): Thread =>
  ({
    id: '11111111-2222-3333-4444-555555555555',
    title: 'Demo',
    provider: 'codex',
    cwd: '/tmp/app',
    model: '',
    effort: '',
    permissionMode: 'full-access',
    status: 'completed',
    createdAt: '',
    updatedAt: '',
    messages,
    activities: [],
    approvals: [],
    sessionId: 'codex-1',
  }) as Thread

describe('switchAgent', () => {
  it('parks the current session with the last message it saw and brings back the other', () => {
    const thread = base([message('u1', 'user', 'Hi'), message('a1', 'assistant', 'Hello')])
    thread.sessions = { claude: { id: 'claude-1', claudeEntry: 'e1', seen: 'u0' } }
    thread.todos = [{ id: '1', text: 'x', status: 'pending' }]
    switchAgent(thread, 'claude')
    expect(thread.provider).toBe('claude')
    expect(thread.sessionId).toBe('claude-1')
    expect(thread.claudeEntry).toBe('e1')
    expect(thread.handoff).toEqual({ after: 'u0' })
    expect(thread.sessions).toEqual({ codex: { id: 'codex-1', seen: 'a1' } })
    expect(thread.todos).toBeUndefined()
  })
  it('keeps an unsent recap when switching away before the agent ran', () => {
    const thread = base([message('u1', 'user', 'Hi'), message('a1', 'assistant', 'Hello')])
    switchAgent(thread, 'claude')
    expect(thread.handoff).toEqual({ after: undefined })
    // Claude never ran (no session): nothing to park for it; Codex comes back owing nothing.
    switchAgent(thread, 'codex')
    expect(thread.sessionId).toBe('codex-1')
    expect(thread.sessions).toBeUndefined()
    expect(thread.handoff).toBeUndefined()
    expect(handoffRecap(thread)).toBe('')
  })
})

describe('handoffRecap', () => {
  it('recaps only the missed turns before the new message, skipping unsent ones', () => {
    const thread = base([
      message('u1', 'user', 'Old question'),
      message('a1', 'assistant', 'Old answer'),
      message('u2', 'user', 'Fix the bug', { provider: 'codex' }),
      message('a2', 'assistant', 'Fixed it'),
      message('u3', 'user', 'never sent', { unsent: true }),
      message('u4', 'user', 'New question'),
    ])
    thread.provider = 'claude'
    thread.handoff = { after: 'a1' }
    const recap = handoffRecap(thread, 'u4')
    expect(recap).toContain('switched to you from Codex')
    expect(recap).toContain('Fix the bug')
    expect(recap).toContain('Fixed it')
    expect(recap).not.toContain('Old question')
    expect(recap).not.toContain('never sent')
    expect(recap).not.toContain('New question')
  })
  it('keeps the newest turns that fit and points to read_thread for the rest', () => {
    const long = 'x'.repeat(3_000)
    const messages = Array.from({ length: 20 }, (_, index) => [
      message(`u${index}`, 'user', `${index} ${long}`),
      message(`a${index}`, 'assistant', long),
    ]).flat()
    const thread = base(messages)
    thread.provider = 'claude'
    thread.handoff = {}
    const recap = handoffRecap(thread)
    expect(recap.length).toBeLessThan(30_000)
    expect(recap).toContain('19 x')
    expect(recap).toContain('read_thread')
    expect(recap).toContain(thread.id)
  })
})
