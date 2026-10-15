import { readFile } from 'node:fs/promises'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PromptImage, Runner } from './types'
import { describeClaudeTool, toolOutput } from './activity'
import { claudeSettings, threadSettings } from '../provider-settings'

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
  const abort = () => {
    abortController.abort()
    releasePrompt()
    closeInput()
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
  let assistantId = String(crypto.randomUUID())
  const toolIds = new Set<string>()
  const stream = query({
    prompt: prompt(),
    options: {
      cwd: ctx.thread.cwd,
      abortController,
      includePartialMessages: true,
      ...claudeSettings(threadSettings(ctx.thread)),
      settingSources: ['user', 'project', 'local'],
      ...(process.env.CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CLAUDE_BIN } : {}),
      ...(ctx.thread.sessionId ? { resume: ctx.thread.sessionId } : {}),
      canUseTool: async (toolName, input, options) => {
        const allow = await ctx.approve({
          id: options.toolUseID,
          title: `Allow ${toolName}?`,
          detail: JSON.stringify(input, null, 2),
        })
        return allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The user declined this tool request.' }
      },
    },
  })
  try {
    const settings = claudeSettings(threadSettings(ctx.thread))
    // Apply resets before sending the prompt, so resume cannot retain an earlier effort override.
    await stream.applyFlagSettings({
      effortLevel: settings.effort ?? null,
      ...(ctx.thread.model ? {} : { model: null }),
    })
    releasePrompt()
    for await (const message of stream) {
      ctx.signal.throwIfAborted()
      if (message.session_id) ctx.session(message.session_id)
      if (message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'message_start') {
          assistantId = event.message.id
          streamed = false
        }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          streamed = true
          ctx.text(assistantId, event.delta.text)
        }
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          toolIds.add(event.content_block.id)
          ctx.activity({
            id: event.content_block.id,
            label: describeClaudeTool(event.content_block.name, {}, ctx.thread.cwd).label,
            status: 'running',
          })
        }
      }
      if (message.type === 'assistant') {
        if (!streamed) {
          const text = message.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
          if (text) ctx.text(message.message.id, text, true)
        }
        for (const block of message.message.content)
          if (block.type === 'tool_use') {
            toolIds.add(block.id)
            ctx.activity({
              id: block.id,
              ...describeClaudeTool(block.name, block.input, ctx.thread.cwd),
              status: 'running',
            })
          }
      }
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content)
          if (block.type === 'tool_result' && toolIds.has(block.tool_use_id)) {
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
      }
    }
    if (!gotResult) throw new Error('Claude disconnected before reporting completion.')
  } finally {
    ctx.signal.removeEventListener('abort', abort)
    releasePrompt()
    closeInput()
    stream.close()
  }
}
