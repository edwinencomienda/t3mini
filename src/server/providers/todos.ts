import type { Todo, TodoStatus } from '../../types'
import { checklistTodos } from '../tools/update-checklist'
import { claudeToolName } from '../tools'

// The agent's to-do checklist, kept on the thread and drawn as a live card (like Claude
// Desktop). Built from:
// - Claude's TodoWrite: the whole list each time;
// - Claude's newer task tools: TaskCreate adds one, TaskUpdate changes or deletes one by id;
// - t3 mini's update_checklist: the whole list each time (Claude's calls are applied here, from
//   the stream, so a subagent's list is left out; Codex's go through the tool itself);
// - Codex's plan updates (turn/plan/updated): the whole list each time.
// Each function returns the new list, or undefined when the call isn't about to-dos.

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const string = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const short = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text)
const status = (value: unknown): TodoStatus =>
  value === 'completed'
    ? 'completed'
    : value === 'in_progress' || value === 'inProgress'
      ? 'in_progress'
      : 'pending'
// A checklist stays small; a runaway list is cut.
const limit = 50

const checklistTool = claudeToolName('update_checklist')
export const todoTools = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', checklistTool])

export function applyClaudeTodo(
  current: Todo[],
  name: string,
  rawInput: unknown,
  toolId: string,
): Todo[] | undefined {
  if (name === checklistTool) return checklistTodos(rawInput)
  const input = object(rawInput)
  if (name === 'TodoWrite') {
    if (!Array.isArray(input.todos)) return undefined
    return input.todos
      .map(object)
      .filter((todo) => string(todo.content))
      .slice(0, limit)
      .map((todo, index) => ({
        id: String(index + 1),
        text: short(string(todo.content)),
        ...(string(todo.activeForm) ? { activeText: short(string(todo.activeForm)) } : {}),
        status: status(todo.status),
      }))
  }
  if (name === 'TaskCreate') {
    const text = string(input.subject) || string(input.description)
    if (!text || current.length >= limit) return undefined
    // The real id arrives with the result (taskCreated); until then it's keyed by the call.
    return [
      ...current,
      {
        id: `call:${toolId}`,
        text: short(text),
        ...(string(input.activeForm) ? { activeText: short(string(input.activeForm)) } : {}),
        status: 'pending',
      },
    ]
  }
  if (name === 'TaskUpdate') {
    const id = string(input.taskId)
    if (!current.some((todo) => todo.id === id)) return undefined
    if (input.status === 'deleted') return current.filter((todo) => todo.id !== id)
    return current.map((todo) =>
      todo.id === id
        ? {
            ...todo,
            ...(string(input.subject) ? { text: short(string(input.subject)) } : {}),
            ...(string(input.activeForm) ? { activeText: short(string(input.activeForm)) } : {}),
            ...(input.status ? { status: status(input.status) } : {}),
          }
        : todo,
    )
  }
  return undefined
}

// TaskCreate's result: its task id, from the structured result or the text ("Task #3 created").
export function taskCreated(
  current: Todo[],
  toolId: string,
  result: unknown,
  text: string | undefined,
): Todo[] | undefined {
  const id =
    string(object(object(result).task).id) || (text ? (/#(\d+)/.exec(text)?.[1] ?? '') : '')
  if (!id || !current.some((todo) => todo.id === `call:${toolId}`)) return undefined
  return current.map((todo) => (todo.id === `call:${toolId}` ? { ...todo, id } : todo))
}

export function codexPlan(params: unknown): Todo[] {
  const plan = object(params).plan
  return (Array.isArray(plan) ? plan : [])
    .map(object)
    .filter((step) => string(step.step))
    .slice(0, limit)
    .map((step, index) => ({
      id: String(index + 1),
      text: short(string(step.step)),
      status: status(step.status),
    }))
}
