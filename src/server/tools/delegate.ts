import { z } from 'zod'
import { agentLabel } from '../delegations'
import { ToolError, defineTool } from './types'

// Sub-agents: delegate_task hands a task to another agent working in this thread's folder, by
// default the same agent as this thread (Claude or Codex), the other one when the user asks.
// It either waits and returns the sub-agent's answer, or runs in the background and reports
// back with a message. list_delegations and stop_delegation manage them; list_models shows the
// models (efforts, tiers) a sub-agent can be given, the same list as the composer's picker. Each shows as a card
// in the reply with a link to its full log. See ../delegations.ts and docs/delegation.md.

const delegationRef = z
  .string()
  .min(1)
  .max(500)
  .describe('The sub-agent’s id (from delegate_task or list_delegations).')
const short = (id?: string) => /^[0-9a-f]{8}/i.exec(id ?? '')?.[0]

export const delegateTask = defineTool({
  name: 'delegate_task',
  label: 'Delegate',
  description:
    'Hand a task to a sub-agent: another agent that works in this same folder, with its own ' +
    'context, and reports its result back to you. This is the default way to split off work ' +
    'or run things in parallel; prefer it over start_thread, which is only for when the user ' +
    'explicitly asks for separate threads or worktrees. Use it for work worth splitting off: ' +
    'research, a review, tests, a self-contained part of a feature, or several independent ' +
    'parts at once (start each with wait: false, then they report back as they finish). ' +
    'By default the sub-agent is the same agent as you; set agent to the other one (Claude or ' +
    'Codex) only when the user asks for it. wait: true (default) returns its answer here; ' +
    'wait: false returns at once and its result arrives as a message later, so keep working or ' +
    'end your turn. Sub-agents share this folder: give parallel ones separate files or areas, ' +
    'and run parts that would edit the same files one after another. Write the task so it ' +
    'stands alone; context: "thread" (default) also gives it a recap of this conversation. To ' +
    'follow up with the same sub-agent (it keeps its memory), pass continue with its id. ' +
    'To pick a model, effort, or service tier, call list_models first for the valid choices. ' +
    'Sub-agents can’t start sub-agents. At most 5 run at once.',
  input: {
    task: z.string().trim().min(1).max(20_000).describe('What the sub-agent should do.'),
    title: z
      .string()
      .trim()
      .max(80)
      .optional()
      .describe('A short name for its card, e.g. "Write handoff tests".'),
    agent: z
      .enum(['claude', 'codex'])
      .optional()
      .describe('Which agent; defaults to the same agent as you. Use the other only when asked.'),
    wait: z
      .boolean()
      .optional()
      .describe('Wait for its answer (default true), or run it in the background (false).'),
    access: z
      .enum(['read-only', 'edit'])
      .optional()
      .describe(
        'read-only: it is told to look and report without changing files. edit (default): ' +
          'it may change files. Either way it has the same tools and access as you.',
      ),
    context: z
      .enum(['none', 'thread'])
      .optional()
      .describe('thread (default): include a recap of this conversation. none: only the task.'),
    model: z
      .string()
      .trim()
      .max(120)
      .optional()
      .describe(
        'A model id from list_models. Leave it out to use your own model (same agent) or the ' +
          'user’s last choice (other agent); defaults are fine.',
      ),
    effort: z
      .string()
      .trim()
      .max(32)
      .optional()
      .describe('An effort level the model supports (see list_models).'),
    serviceTier: z
      .string()
      .trim()
      .max(32)
      .optional()
      .describe('A service tier the model offers, e.g. a fast tier (see list_models).'),
    continue: delegationRef
      .optional()
      .describe('Send this task to an existing sub-agent of yours instead of starting a new one.'),
  },
  safety: 'approval',
  summarize: (input) => input.title || input.task?.replace(/\s+/g, ' ').slice(0, 60) || undefined,
  async run(context, input) {
    return context.delegates.start(input)
  },
})

export const listDelegations = defineTool({
  name: 'list_delegations',
  label: 'List sub-agents',
  description:
    'List your sub-agents: each one’s id, title, agent, status (working, waiting for the user, ' +
    'done, failed, stopped), the files it changed, and the start of its answer.',
  input: {},
  safety: 'safe',
  async run(context) {
    return context.delegates.list()
  },
})

export const stopDelegation = defineTool({
  name: 'stop_delegation',
  label: 'Stop sub-agent',
  description: 'Stop one of your sub-agents. Files it already changed stay changed.',
  input: { id: delegationRef },
  safety: 'safe',
  summarize: (input) => short(input.id),
  async run(context, input) {
    return context.delegates.stop(input.id)
  },
})

export const listModels = defineTool({
  name: 'list_models',
  label: 'List models',
  description:
    'List the models a sub-agent can use (the same list the user sees in the composer’s model ' +
    'picker): each model’s id, name, description, effort levels, default effort, and service ' +
    'tiers. Pass the id as delegate_task’s model, and only an effort or tier listed for it.',
  input: {
    agent: z
      .enum(['claude', 'codex'])
      .optional()
      .describe('Only this agent’s models; both when left out.'),
  },
  safety: 'safe',
  summarize: (input) => (input.agent ? agentLabel(input.agent) : undefined),
  async run(context, input) {
    // Loaded here: ../models imports the Claude provider, which imports this tool registry.
    const { describeModels, getModels } = await import('../models')
    const agents = input.agent ? [input.agent] : (['claude', 'codex'] as const)
    const sections = await Promise.all(
      agents.map((agent) =>
        getModels(agent, context.cwd).then(
          (models) => describeModels(agentLabel(agent), models),
          () => `${agentLabel(agent)}: couldn’t load its models (is it installed and signed in?).`,
        ),
      ),
    )
    if (input.agent && sections[0]?.includes('couldn’t load')) throw new ToolError(sections[0])
    return sections.join('\n\n')
  },
})

export const delegateTools = [delegateTask, listDelegations, stopDelegation, listModels]
