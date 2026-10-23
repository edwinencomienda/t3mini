import { z } from 'zod'
import { defineTool } from './types'

// The agent's to-do checklist as a t3 mini tool, so both agents have it loaded from the start
// (Claude's own to-do tools are deferred behind a tool search; Codex's plan is up to the
// model). It sends the whole list each time, like Claude's TodoWrite, and feeds the same
// checklist card (thread.todos). Claude's to-do tools and Codex's plan still work too.
const item = z.object({
  text: z.string().trim().min(1).max(200).describe('The step, e.g. "Run the tests".'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe('pending, in_progress (the one you are on now), or completed.'),
  activeText: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional: the step as it happens, e.g. "Running the tests".'),
})

export const updateChecklist = defineTool({
  name: 'update_checklist',
  label: 'Update checklist',
  description:
    'Show your plan for this task as a live checklist the user can follow. Send the whole ' +
    'list every time (it replaces the previous one). Use it for multi-step work: 3 or more ' +
    'steps, or changes across several files. Create it when you start, keep exactly one item ' +
    'in_progress while you work, and mark each item completed as soon as it is done (not all ' +
    'at the end). Add or drop items when the plan changes. Skip it for quick questions and ' +
    'one-line fixes. Send an empty list to clear it.',
  input: {
    items: z.array(item).max(50).describe('Every item, in order.'),
  },
  safety: 'safe',
  kind: 'todo',
  summarize: (input) => {
    const items = input.items ?? []
    if (!items.length) return 'Cleared'
    const done = items.filter((entry) => entry.status === 'completed').length
    return `${done} of ${items.length} done`
  },
  async run(context, input) {
    const todos = input.items.map((entry, index) => ({
      id: String(index + 1),
      text: entry.text,
      ...(entry.activeText ? { activeText: entry.activeText } : {}),
      status: entry.status,
    }))
    context.setTodos(todos)
    if (!todos.length) return 'Cleared the checklist.'
    const done = todos.filter((todo) => todo.status === 'completed').length
    return done === todos.length
      ? `Checklist updated: all ${todos.length} done.`
      : `Checklist updated: ${done} of ${todos.length} done. Update it as you finish each item.`
  },
})
