import { describe, expect, it } from 'vitest'
import { applyClaudeTodo, codexPlan, taskCreated, todoTools } from './todos'

it('takes TodoWrite’s whole list', () => {
  expect(
    applyClaudeTodo(
      [],
      'TodoWrite',
      {
        todos: [
          { content: 'Read the diff', status: 'completed', activeForm: 'Reading the diff' },
          { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
          { content: '  ', status: 'pending' },
          { content: 'Report', status: 'pending' },
        ],
      },
      'call-1',
    ),
  ).toEqual([
    { id: '1', text: 'Read the diff', activeText: 'Reading the diff', status: 'completed' },
    { id: '2', text: 'Run tests', activeText: 'Running tests', status: 'in_progress' },
    { id: '3', text: 'Report', status: 'pending' },
  ])
  expect(applyClaudeTodo([], 'TodoWrite', { todos: 'nope' }, 'call-1')).toBeUndefined()
  expect(applyClaudeTodo([], 'Bash', { command: 'ls' }, 'call-1')).toBeUndefined()
})

it('follows the task tools: create, learn the id, update, delete', () => {
  let todos = applyClaudeTodo(
    [],
    'TaskCreate',
    { subject: 'Build', description: 'Build it', activeForm: 'Building' },
    'call-1',
  )!
  expect(todos).toEqual([
    { id: 'call:call-1', text: 'Build', activeText: 'Building', status: 'pending' },
  ])
  // The id comes from the structured result, or from the result text.
  todos = taskCreated(todos, 'call-1', { task: { id: '7', subject: 'Build' } }, undefined)!
  expect(todos[0]!.id).toBe('7')
  todos = applyClaudeTodo(todos, 'TaskCreate', { subject: 'Test', description: '' }, 'call-2')!
  todos = taskCreated(todos, 'call-2', undefined, 'Task #8 created successfully: Test')!
  expect(todos.map((todo) => todo.id)).toEqual(['7', '8'])
  todos = applyClaudeTodo(todos, 'TaskUpdate', { taskId: '7', status: 'in_progress' }, 'call-3')!
  expect(todos[0]!.status).toBe('in_progress')
  expect(
    applyClaudeTodo(todos, 'TaskUpdate', { taskId: '99', status: 'completed' }, 'c'),
  ).toBeUndefined()
  todos = applyClaudeTodo(todos, 'TaskUpdate', { taskId: '8', status: 'deleted' }, 'call-4')!
  expect(todos.map((todo) => todo.id)).toEqual(['7'])
  expect(taskCreated(todos, 'unknown', { task: { id: '9' } }, undefined)).toBeUndefined()
})

it('reads Codex’s plan', () => {
  expect(
    codexPlan({
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Fix', status: 'inProgress' },
        { step: 'Verify', status: 'pending' },
        { step: '' },
      ],
    }),
  ).toEqual([
    { id: '1', text: 'Inspect', status: 'completed' },
    { id: '2', text: 'Fix', status: 'in_progress' },
    { id: '3', text: 'Verify', status: 'pending' },
  ])
  expect(codexPlan({})).toEqual([])
})

describe('update_checklist from Claude', () => {
  const name = 'mcp__t3mini__update_checklist'
  it('is read from the stream like TodoWrite, replacing the list', () => {
    expect(todoTools.has(name)).toBe(true)
    expect(
      applyClaudeTodo(
        [{ id: '9', text: 'Old', status: 'pending' }],
        name,
        { items: [{ text: 'New', status: 'in_progress', activeText: 'Doing new' }] },
        'call-1',
      ),
    ).toEqual([{ id: '1', text: 'New', activeText: 'Doing new', status: 'in_progress' }])
  })
  it('clears on an empty list and ignores an invalid call', () => {
    expect(applyClaudeTodo([], name, { items: [] }, 'c')).toEqual([])
    expect(
      applyClaudeTodo([], name, { items: [{ text: 'x', status: 'done' }] }, 'c'),
    ).toBeUndefined()
  })
})
