import { expect, it, vi } from 'vitest'
import { updateChecklist } from './update-checklist'
import { runTool, toolInstructions } from '.'
import { describeClaudeTool, describeCodexItem } from '../providers/activity'
import type { ToolContext } from './types'

const context = (setTodos: ToolContext['setTodos']): ToolContext => ({
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
  setTodos,
})

it('replaces the checklist with the whole list', async () => {
  const setTodos = vi.fn()
  const result = await runTool(updateChecklist, context(setTodos), {
    items: [
      { text: ' Read the code ', status: 'completed' },
      { text: 'Run the tests', status: 'in_progress', activeText: 'Running the tests' },
      { text: 'Update the docs', status: 'pending' },
    ],
  })
  expect(setTodos).toHaveBeenCalledWith([
    { id: '1', text: 'Read the code', status: 'completed' },
    { id: '2', text: 'Run the tests', activeText: 'Running the tests', status: 'in_progress' },
    { id: '3', text: 'Update the docs', status: 'pending' },
  ])
  expect(result.ok).toBe(true)
  expect(result.text).toContain('1 of 3 done')
})

it('clears the checklist with an empty list', async () => {
  const setTodos = vi.fn()
  const result = await runTool(updateChecklist, context(setTodos), { items: [] })
  expect(setTodos).toHaveBeenCalledWith([])
  expect(result.text).toBe('Cleared the checklist.')
})

it('refuses bad items without touching the checklist', async () => {
  const setTodos = vi.fn()
  const bad = [
    { items: [{ text: '  ', status: 'pending' }] },
    { items: [{ text: 'Step', status: 'done' }] },
    { items: Array.from({ length: 51 }, () => ({ text: 'Step', status: 'pending' })) },
    {},
  ]
  for (const input of bad)
    expect((await runTool(updateChecklist, context(setTodos), input)).ok).toBe(false)
  expect(setTodos).not.toHaveBeenCalled()
})

it('is drawn as the checklist card for both agents, not as a step', () => {
  const items = [{ text: 'Step', status: 'pending' }]
  expect(describeClaudeTool('mcp__t3mini__update_checklist', { items }, '/tmp')).toMatchObject({
    todo: true,
  })
  expect(
    describeCodexItem(
      { type: 'dynamicToolCall', tool: 'update_checklist', arguments: { items } },
      '/tmp',
    ),
  ).toMatchObject({ todo: true })
})

it('is mentioned in the instructions both agents get', () => {
  expect(toolInstructions).toContain('update_checklist')
})
