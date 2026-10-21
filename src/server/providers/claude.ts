import { readFile } from 'node:fs/promises'
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  claudeToolName,
  findClaudeTool,
  maskInput,
  mcpServerName,
  runTool,
  toolInstructions,
  tools,
} from '../tools'
import type { PromptImage, Runner } from './types'
import type { Activity } from '../../types'
import { describeClaudeTool, toolOutput } from './activity'
import { applyClaudeTodo, taskCreated, todoTools } from './todos'
import { claudeSettings, threadSettings } from '../provider-settings'
import { claudeExecutable } from '../cli-updates'
import { z } from 'zod'

// AskUserQuestion's input, checked before it's shown: 1–4 questions with a few options each.
const questionInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(1000),
        header: z.string().max(100).optional(),
        multiSelect: z.boolean().optional(),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(200),
              description: z.string().max(1000).optional(),
            }),
          )
          .min(1)
          .max(8),
      }),
    )
    .min(1)
    .max(4),
})

// Run the installed Claude Code CLI, so updating it updates t3 mini too. Without one, the copy
// bundled with the Agent SDK runs.
export function claudeExecutableOption() {
  const path = claudeExecutable()
  return path ? { pathToClaudeCodeExecutable: path } : {}
}

export const runClaude: Runner = async (ctx) => {
  ctx.signal.throwIfAborted()
  const abortController = new AbortController()
  let releasePrompt!: () => void
  const ready = new Promise<void>((resolve) => {
    releasePrompt = resolve
  })
  // The input stays open while the turn runs so messages sent mid-turn can be steered in.
  // It closes at the turn's result; anything already sent still runs before Claude exits.
  const inbox: SDKUserMessage[] = []
  let wake: (() => void) | undefined
  let inputClosed = false
  const closeInput = () => {
    inputClosed = true
    wake?.()
  }
  // Stop: ask Claude Code to end the turn (interrupt), the way Claude Desktop does. It ends it
  // cleanly, so the session's transcript stays whole for the next turn. If it hasn't finished
  // in a few seconds (or can't be asked yet), the process is killed instead. The thread already
  // shows as stopped either way (see AgentService.stop).
  let interrupt: (() => Promise<unknown>) | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const abort = () => {
    releasePrompt()
    closeInput()
    if (!interrupt) return abortController.abort()
    killTimer = setTimeout(() => abortController.abort(), 3_000)
    Promise.resolve()
      .then(interrupt)
      .catch(() => abortController.abort())
  }
  // Images go first as base64 image blocks, followed by the text.
  async function content(text: string, attached: PromptImage[]) {
    const images = await Promise.all(
      attached.map(async (image) => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: image.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data: (await readFile(image.path)).toString('base64'),
        },
      })),
    )
    return images.length ? [...images, ...(text ? [{ type: 'text' as const, text }] : [])] : text
  }
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    await ready
    if (abortController.signal.aborted) return
    yield {
      type: 'user',
      message: { role: 'user', content: await content(ctx.prompt, ctx.images) },
      parent_tool_use_id: null,
      // A known id, so this turn can be dropped later (resumeDropsTurn).
      ...(ctx.promptId
        ? { uuid: ctx.promptId as `${string}-${string}-${string}-${string}-${string}` }
        : {}),
    }
    for (;;) {
      while (inbox.length) yield inbox.shift()!
      if (inputClosed || abortController.signal.aborted) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      wake = undefined
    }
  }
  ctx.onSteer?.(async ({ prompt: text, images }) => {
    if (inputClosed || abortController.signal.aborted) return false
    const message = await content(text, images)
    if (inputClosed) return false
    // 'next' folds the message into the running turn at its next step.
    inbox.push({
      type: 'user',
      message: { role: 'user', content: message },
      parent_tool_use_id: null,
      priority: 'next',
    })
    wake?.()
    return true
  })
  ctx.signal.addEventListener('abort', abort, { once: true })
  let gotResult = false
  let streamed = false
  // A compaction in progress: its step id, what's known so far, and which of its two closing
  // messages (the status saying how it went, the boundary with the counts) have arrived.
  let compacting:
    | { id: string; compact: NonNullable<Activity['compact']>; ended?: boolean; counted?: boolean }
    | undefined
  let assistantId = String(crypto.randomUUID())
  const toolIds = new Set<string>()
  // t3 mini's own tools (show_image…) run in this process as an MCP server for this turn.
  const t3Tools = createSdkMcpServer({
    name: mcpServerName,
    version: '1.0.0',
    instructions: toolInstructions,
    tools: tools.map((definition) =>
      tool(
        definition.name,
        definition.description,
        definition.input,
        async (input) => {
          // Refusals (bad path, wrong file type…) go back to Claude as a readable error.
          const result = await runTool(definition, ctx.tools, input)
          return {
            content: [
              { type: 'text' as const, text: result.text },
              // A screenshot the agent asked for, so it can see the page.
              ...(result.image
                ? [
                    {
                      type: 'image' as const,
                      data: result.image.data,
                      mimeType: result.image.mimeType,
                    },
                  ]
                : []),
            ],
            isError: !result.ok,
          }
        },
        // Load up front, so Claude can call it directly instead of searching for it first.
        { alwaysLoad: true },
      ),
    ),
  })
  // Work-log labels are cosmetic: if describing a step ever fails, show the plain tool name
  // rather than failing the turn.
  const describe = (name: string, input: unknown) => {
    try {
      return describeClaudeTool(name, input, ctx.cwd, {
        refName: (ref) => ctx.tools.browser?.refName(ref),
      })
    } catch {
      return { label: name }
    }
  }
  // Display-only tools never need the user's approval.
  const safeTools = tools
    .filter((definition) => definition.safety === 'safe')
    .map((definition) => claudeToolName(definition.name))
  // Subagents by their Agent tool call, for labelling their steps in the work log.
  const agentNames = new Map<string, string>()
  const agentOf = (parent: string | null | undefined) =>
    parent ? { agent: agentNames.get(parent) ?? 'Subagent' } : {}
  // Claude's tasks this turn (subagents, shells…); the backgrounded ones are shown as running.
  const tasks = new Map<string, { description: string; background: boolean }>()
  const reportBackground = () =>
    ctx.background?.(
      [...tasks]
        .filter(([, task]) => task.background)
        .map(([id, task]) => ({ id, description: task.description })),
    )
  const rewinding = Boolean(ctx.thread.sessionId && ctx.rewind?.claudeResumeAt)
  let reportedRewind = false
  const stream = query({
    prompt: prompt(),
    options: {
      cwd: ctx.cwd,
      abortController,
      includePartialMessages: true,
      ...claudeSettings(threadSettings(ctx.thread)),
      settingSources: ['user', 'project', 'local'],
      mcpServers: { [mcpServerName]: t3Tools },
      allowedTools: safeTools,
      // Claude's to-do tools (TodoWrite / TaskCreate…) are off by default outside the
      // interactive CLI; t3 mini draws them as a checklist card, so turn them on.
      env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
      ...claudeExecutableOption(),
      ...(ctx.thread.sessionId ? { resume: ctx.thread.sessionId } : {}),
      // Editing a stopped turn: resume from the last entry before it, dropping that turn. The
      // CLI checks that only that turn is dropped and refuses otherwise (see rewindRefused).
      ...(rewinding
        ? {
            resumeSessionAt: ctx.rewind!.claudeResumeAt,
            ...(ctx.rewind!.claudePrompt ? { resumeDropsTurn: ctx.rewind!.claudePrompt } : {}),
          }
        : {}),
      canUseTool: async (toolName, input, options) => {
        if (safeTools.includes(toolName)) return { behavior: 'allow', updatedInput: input }
        // A question for you, not a permission: Claude Code hands it over even with full access.
        // Your answers go back in the tool's input (question text → answer).
        if (toolName === 'AskUserQuestion' && ctx.ask) {
          const parsed = questionInput.safeParse(input)
          if (parsed.success) {
            const { questions } = parsed.data
            const answers = await ctx.ask({
              id: options.toolUseID,
              title: questions.length === 1 ? 'Claude has a question' : 'Claude has some questions',
              questions,
            })
            return answers
              ? { behavior: 'allow', updatedInput: { ...input, answers } }
              : {
                  behavior: 'deny',
                  message:
                    'The user skipped this question. Continue with your best judgment, or ask in plain text if you really need an answer.',
                }
          }
        }
        const allow = await ctx.approve({
          id: options.toolUseID,
          title: `Allow ${toolName}?`,
          detail: JSON.stringify(maskInput(findClaudeTool(toolName), input), null, 2),
        })
        return allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The user declined this tool request.' }
      },
    },
  })
  interrupt = () => stream.interrupt()
  try {
    const settings = claudeSettings(threadSettings(ctx.thread))
    // Apply resets before sending the prompt, so resume cannot retain an earlier effort override.
    await stream.applyFlagSettings({
      effortLevel: settings.effort ?? null,
      ...(ctx.thread.model ? {} : { model: null }),
    })
    releasePrompt()
    for await (const message of stream) {
      if (ctx.signal.aborted) {
        // Stopped: Claude is wrapping up the interrupted turn. Keep its place in the
        // conversation for the next turn, but show nothing more.
        if ((message.type === 'assistant' || message.type === 'user') && message.uuid)
          if (!('isReplay' in message && message.isReplay)) ctx.entry?.(message.uuid)
        if (message.type === 'result') break
        continue
      }
      if (message.session_id) ctx.session(message.session_id)
      // The session resumed past the rewind check once it produces anything but an error.
      if (rewinding && !reportedRewind && message.type !== 'result' && message.type !== 'system') {
        reportedRewind = true
        ctx.rewound?.(true)
      }
      if ((message.type === 'assistant' || message.type === 'user') && message.uuid)
        if (!('isReplay' in message && message.isReplay)) ctx.entry?.(message.uuid)
      // Background work (subagents, shells) keeps the turn open after Claude's last reply; show
      // what's still running so a long wait doesn't look stuck.
      if (message.type === 'system') {
        // Compacting: a status while it runs, then (in either order) the status saying how it
        // went and a boundary with the token counts. One step, kept open until both arrive.
        if (message.subtype === 'status') {
          if (message.status === 'compacting' && (!compacting || compacting.ended)) {
            compacting = { id: `compact:${crypto.randomUUID()}`, compact: {} }
            ctx.activity({
              id: compacting.id,
              label: 'Compact',
              compact: compacting.compact,
              status: 'running',
            })
          } else if (message.status !== 'compacting' && compacting && message.compact_result) {
            const failed = message.compact_result === 'failed'
            if (failed) compacting.compact.error = message.compact_error || 'Compacting failed.'
            ctx.activity({
              id: compacting.id,
              label: 'Compact',
              compact: { ...compacting.compact },
              status: failed ? 'failed' : 'completed',
            })
            compacting.ended = true
            if (failed || compacting.counted) compacting = undefined
          }
        } else if (message.subtype === 'compact_boundary') {
          const meta = message.compact_metadata
          const compact = {
            ...(compacting?.compact ?? {}),
            trigger: meta.trigger,
            before: meta.pre_tokens,
            ...(meta.post_tokens !== undefined ? { after: meta.post_tokens } : {}),
            ...(meta.duration_ms !== undefined ? { ms: meta.duration_ms } : {}),
          }
          // A manual /compact can come as the boundary alone: a step of its own.
          if (!compacting || compacting.counted) {
            ctx.activity({
              id: `compact:${crypto.randomUUID()}`,
              label: 'Compact',
              compact,
              status: 'completed',
            })
          } else {
            compacting.compact = compact
            compacting.counted = true
            ctx.activity({ id: compacting.id, label: 'Compact', compact, status: 'completed' })
            if (compacting.ended) compacting = undefined
          }
        } else if (message.subtype === 'task_started') {
          tasks.set(message.task_id, {
            description: message.description,
            background: Boolean(message.is_backgrounded),
          })
          reportBackground()
        } else if (message.subtype === 'task_updated') {
          const task = tasks.get(message.task_id)
          const { status, description, is_backgrounded } = message.patch
          if (task) {
            if (description) task.description = description
            if (is_backgrounded !== undefined) task.background = is_backgrounded
            if (status && !['pending', 'running', 'paused'].includes(status))
              tasks.delete(message.task_id)
            reportBackground()
          }
        } else if (message.subtype === 'task_notification') {
          tasks.delete(message.task_id)
          reportBackground()
        }
      }
      if (message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'message_start') {
          assistantId = event.message.id
          streamed = false
        }
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta' &&
          !message.parent_tool_use_id
        ) {
          streamed = true
          ctx.text(assistantId, event.delta.text)
        }
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          toolIds.add(event.content_block.id)
          ctx.activity({
            id: event.content_block.id,
            label: describe(event.content_block.name, {}).label,
            status: 'running',
            ...agentOf(message.parent_tool_use_id),
          })
        }
      }
      if (message.type === 'assistant') {
        // A subagent's own words stay in its task; only its steps show in the work log.
        if (!streamed && !message.parent_tool_use_id) {
          const text = message.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
          if (text) ctx.text(message.message.id, text, true)
        }
        for (const block of message.message.content)
          if (block.type === 'tool_use') {
            toolIds.add(block.id)
            // Remember subagents by their task description, to label their steps.
            if (block.name === 'Agent' || block.name === 'Task') {
              const description = (block.input as { description?: unknown }).description
              if (typeof description === 'string') agentNames.set(block.id, description)
            }
            ctx.activity({
              id: block.id,
              ...describe(block.name, block.input),
              status: 'running',
              ...agentOf(message.parent_tool_use_id),
            })
            // The main agent's to-do list (a subagent's own list stays in its task).
            if (todoTools.has(block.name) && !message.parent_tool_use_id) {
              const todos = applyClaudeTodo(
                ctx.thread.todos ?? [],
                block.name,
                block.input,
                block.id,
              )
              if (todos) ctx.todos?.(todos)
            }
          }
      }
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content)
          if (block.type === 'tool_result' && toolIds.has(block.tool_use_id)) {
            const created = block.is_error
              ? undefined
              : taskCreated(
                  ctx.thread.todos ?? [],
                  block.tool_use_id,
                  message.tool_use_result,
                  toolOutput(block.content),
                )
            if (created) ctx.todos?.(created)
            ctx.activity({
              id: block.tool_use_id,
              label: 'Tool',
              output: toolOutput(block.content),
              status: block.is_error ? 'failed' : 'completed',
            })
          }
      }
      if (message.type === 'result') {
        gotResult = true
        // No more steering into this run; messages already sent still play out.
        closeInput()
        if (message.is_error || message.subtype !== 'success')
          throw new Error(
            'errors' in message
              ? message.errors.join('\n')
              : 'Claude could not complete this turn.',
          )
        // Its reply so far is an answer, even if background work wakes it up again later.
        ctx.replied?.()
      }
    }
    ctx.signal.throwIfAborted()
    if (!gotResult) throw new Error('Claude disconnected before reporting completion.')
  } finally {
    clearTimeout(killTimer)
    ctx.signal.removeEventListener('abort', abort)
    releasePrompt()
    closeInput()
    stream.close()
  }
}
