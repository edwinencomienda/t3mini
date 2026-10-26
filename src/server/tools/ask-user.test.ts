import { expect, it, vi } from 'vitest'
import { askUser } from './ask-user'
import { instructionsFor, runTool, toolsFor } from '.'
import type { ToolContext } from './types'

const context = (ask: ToolContext['ask']): ToolContext => ({
  cwd: process.cwd(),
  attach: vi.fn(),
  saveImage: vi.fn(),
  processes: {} as never,
  threads: {} as never,
  delegates: {} as never,
  browser: {} as never,
  saveHtml: async () => ({ id: 'x.html' }),
  renderHtml: vi.fn(),
  showHtml: vi.fn(),
  saveMedia: async () => ({ id: 'x.mp4' }),
  readThread: async () => '',
  rename: vi.fn(),
  setTodos: vi.fn(),
  showStatus: vi.fn(),
  ask,
})
const question = {
  question: 'Which database should we use?',
  header: 'Database',
  options: [
    { label: 'Postgres (Recommended)', description: 'Matches production' },
    { label: 'SQLite', description: 'Simplest for local work' },
  ],
}

it('shows the questions on the card and gives the agent the answers', async () => {
  const ask = vi.fn(async () => ({ [question.question]: 'Postgres (Recommended)' }))
  const result = await runTool(askUser, context(ask), { questions: [question] })
  expect(ask).toHaveBeenCalledWith({ title: 'A question for you', questions: [question] })
  expect(result).toEqual({
    ok: true,
    text: 'The user answered:\n\nWhich database should we use?\n→ Postgres (Recommended)',
  })
})

it('tells the agent when the user skipped', async () => {
  const result = await runTool(
    askUser,
    context(async () => null),
    { questions: [question] },
  )
  expect(result.ok).toBe(true)
  expect(result.text).toContain('skipped')
})

it('refuses questions that are not real choices, without asking', async () => {
  const ask = vi.fn(async () => ({}))
  const none = { ...question, options: [] }
  for (const questions of [[], [none], Array.from({ length: 5 }, () => question)])
    expect((await runTool(askUser, context(ask), { questions })).ok).toBe(false)
  expect(ask).not.toHaveBeenCalled()
})

it('is only for Codex: Claude keeps its own AskUserQuestion', () => {
  const names = (provider: 'claude' | 'codex') => toolsFor(provider).map((tool) => tool.name)
  expect(names('codex')).toContain('ask_user')
  expect(names('claude')).not.toContain('ask_user')
  expect(instructionsFor('codex')).toContain('ask_user')
  expect(instructionsFor('claude')).not.toContain('ask_user')
})
