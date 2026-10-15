import { z } from 'zod'
import { defineTool } from './types'

// Renames the thread the agent is working in (only that one), so a conversation can get a
// clearer sidebar title when the user asks for it.
export const renameThread = defineTool({
  name: 'rename_thread',
  label: 'Rename thread',
  description:
    'Rename the current t3 mini thread (the conversation the user sees in the sidebar). Use it ' +
    'only when the user asks to rename or retitle this thread or session. Keep the title short ' +
    '(a few words) and specific. It cannot rename other threads.',
  input: {
    title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe('The new thread title, up to 120 characters.'),
  },
  safety: 'safe',
  summarize: (input) => input.title || undefined,
  async run(context, input) {
    const title = await context.rename(input.title)
    return `Renamed this thread to "${title}".`
  },
})
