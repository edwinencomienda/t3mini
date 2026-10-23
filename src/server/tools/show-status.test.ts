import { expect, it, vi } from 'vitest'
import { safeLink, showStatus } from './show-status'
import { runTool, toolInstructions } from '.'
import type { StatusCard, ToolContext } from './types'

const context = (showStatusCard: ToolContext['showStatus']): ToolContext => ({
  cwd: process.cwd(),
  attach: vi.fn(),
  saveImage: vi.fn(),
  processes: {} as never,
  threads: {} as never,
  browser: {} as never,
  saveHtml: async () => ({ id: 'x.html' }),
  saveMedia: async () => ({ id: 'x.mp4' }),
  readThread: async () => '',
  rename: vi.fn(),
  setTodos: vi.fn(),
  showStatus: showStatusCard,
})
const base = { id: 'push', kind: 'push', status: 'running', title: 'Pushing to GitHub' }

it('shows a card and tells the agent how to update it', async () => {
  const show = vi.fn((_card: StatusCard) => 'created' as const)
  const result = await runTool(showStatus, context(show), {
    ...base,
    detail: 'myorg/myapp · main',
    commits: [{ sha: '30CDFB399C18FE65', message: 'Fewer re-renders' }],
  })
  expect(result.ok).toBe(true)
  expect(result.text).toContain('id "push"')
  expect(show).toHaveBeenCalledWith({
    ...base,
    detail: 'myorg/myapp · main',
    commits: [{ sha: '30cdfb3', message: 'Fewer re-renders' }],
  })
})

it('only takes plain https links', async () => {
  const show = vi.fn(() => 'created' as const)
  for (const url of [
    'javascript:alert(1)',
    'http://myapp.example.com',
    'file:///etc/passwd',
    'https://user:secret@example.com',
    'not a url',
  ])
    expect((await runTool(showStatus, context(show), { ...base, url })).ok).toBe(false)
  expect(show).not.toHaveBeenCalled()
  expect(safeLink('https://myapp.vercel.app')).toBe('https://myapp.vercel.app/')
})

it('refuses a stage that is not one of the stages, and unknown kinds or states', async () => {
  const show = vi.fn(() => 'created' as const)
  const ctx = context(show)
  const stages = { stages: ['Build', 'Deploy'] }
  expect((await runTool(showStatus, ctx, { ...base, ...stages, stage: 'Live' })).ok).toBe(false)
  expect((await runTool(showStatus, ctx, { ...base, kind: 'rocket' })).ok).toBe(false)
  expect((await runTool(showStatus, ctx, { ...base, status: 'stopped' })).ok).toBe(false)
  expect((await runTool(showStatus, ctx, { ...base, id: 'has spaces' })).ok).toBe(false)
  expect(show).not.toHaveBeenCalled()
  expect((await runTool(showStatus, ctx, { ...base, ...stages, stage: 'Build' })).ok).toBe(true)
})

it('is mentioned in the instructions both agents get', () => {
  expect(toolInstructions).toContain('show_status')
})
