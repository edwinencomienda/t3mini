import { readFile } from 'node:fs/promises'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Runner } from './types'
import { claudeSettings, threadSettings } from '../provider-settings'

export const runClaude: Runner = async (ctx) => {
  ctx.signal.throwIfAborted()
  const abortController = new AbortController()
  let releasePrompt!: () => void
  const ready = new Promise<void>((resolve) => {
    releasePrompt = resolve
  })
  const abort = () => {
    abortController.abort()
    releasePrompt()
  }
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    await ready
    if (abortController.signal.aborted) return
    // Images go first as base64 image blocks, followed by the text.
    const images = await Promise.all(
      ctx.images.map(async (image) => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: image.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data: (await readFile(image.path)).toString('base64'),
        },
      })),
    )
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: images.length
          ? [...images, ...(ctx.prompt ? [{ type: 'text' as const, text: ctx.prompt }] : [])]
          : ctx.prompt,
      },
      parent_tool_use_id: null,
    }
  }
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
            label: event.content_block.name,
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
              label: block.name,
              detail: JSON.stringify(block.input, null, 2),
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
              status: block.is_error ? 'failed' : 'completed',
            })
          }
      }
      if (message.type === 'result') {
        gotResult = true
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
    stream.close()
  }
}
