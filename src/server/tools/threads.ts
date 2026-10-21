import { z } from 'zod'
import { defineTool } from './types'

// Orchestration: a lead thread starts helper threads (each a normal t3 mini thread, in its own
// worktree by default), messages, lists, stops, and deletes them. Helpers report back to the
// lead automatically when they finish (AgentService.reportToLead). One level only: helpers
// can't start helpers. A lead only controls its own helpers. See docs/orchestration.md.

const threadRef = z
  .string()
  .min(1)
  .max(500)
  .describe('The helper thread’s id (from start_thread or list_threads).')
const short = (id?: string) => /^[0-9a-f]{8}/i.exec(id ?? '')?.[0]

export const startThread = defineTool({
  name: 'start_thread',
  label: 'Start thread',
  description:
    'Start a helper thread: another agent working on a task in parallel, in the same project. ' +
    'Use it when the user asks you to split work across agents, run tasks in parallel, or hand ' +
    'something to Claude or Codex. Each helper is a normal t3 mini thread the user can open, and ' +
    'works in its own git worktree (its own checkout and t3m/… branch; in a project that isn’t a ' +
    'git repository, the project folder), so helpers never overwrite each other or the user’s folder. Write the task so it stands ' +
    'alone: the helper can’t see this conversation. It runs in the background; when it finishes, ' +
    'its final answer (and its branch) arrives here as a message, so end your turn instead of ' +
    'waiting or polling. Helpers can’t start helpers of their own. At most 5 run at once.',
  input: {
    task: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .describe('The helper’s instructions, complete on their own.'),
    title: z
      .string()
      .trim()
      .max(80)
      .optional()
      .describe('A short sidebar title for the helper, e.g. "Add dark mode".'),
    agent: z
      .enum(['claude', 'codex'])
      .optional()
      .describe('Which agent runs it; defaults to the same agent as this thread.'),
  },
  safety: 'approval',
  summarize: (input) => input.title || input.task?.slice(0, 60) || undefined,
  async run(context, input) {
    const helper = await context.threads.start(input)
    return (
      `Started helper thread "${helper.title}" (id ${helper.id}) on ${helper.agent}` +
      `${helper.worktree ? ' in a new worktree' : ' in the project folder (not a git repository)'}. ` +
      'It reports back here when it finishes; end your turn now rather than waiting.'
    )
  },
})

export const messageThread = defineTool({
  name: 'message_thread',
  label: 'Message thread',
  description:
    'Send a follow-up to one of your helper threads (e.g. "also add tests", or an answer to its ' +
    'question). If it’s working, the message joins its current turn; otherwise it starts a new ' +
    'one. It reports back here again when it finishes.',
  input: {
    thread: threadRef,
    text: z.string().trim().min(1).max(20_000).describe('The message for the helper.'),
  },
  safety: 'approval',
  summarize: (input) => short(input.thread),
  async run(context, input) {
    return context.threads.message(input.thread, input.text)
  },
})

export const listThreads = defineTool({
  name: 'list_threads',
  label: 'List threads',
  description:
    'List your helper threads: each one’s id, title, agent, status (working, waiting for the ' +
    'user, completed, failed, stopped), branch, and the start of its latest reply. For a ' +
    'helper’s whole conversation use read_thread with its id.',
  input: {},
  safety: 'safe',
  async run(context) {
    return context.threads.list()
  },
})

export const stopThread = defineTool({
  name: 'stop_thread',
  label: 'Stop thread',
  description:
    'Stop one of your helper threads’ current turn (like the user pressing Stop). Its work so ' +
    'far stays; message_thread can start it again.',
  input: { thread: threadRef },
  safety: 'safe',
  summarize: (input) => short(input.thread),
  async run(context, input) {
    return context.threads.stop(input.thread)
  },
})

export const deleteThread = defineTool({
  name: 'delete_thread',
  label: 'Delete thread',
  description:
    'Delete one of your helper threads (stopping it first if it’s running), e.g. after its work ' +
    'was merged or isn’t needed. Its worktree folder is removed unless it has uncommitted ' +
    'changes; its branch always stays. Only delete when the user asked or clearly agreed.',
  input: { thread: threadRef },
  safety: 'approval',
  summarize: (input) => short(input.thread),
  async run(context, input) {
    return context.threads.remove(input.thread)
  },
})

export const threadTools = [startThread, messageThread, listThreads, stopThread, deleteThread]
