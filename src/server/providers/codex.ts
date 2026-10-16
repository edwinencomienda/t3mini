import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { Runner } from './types'
import { openCodexClient } from './codex-client'
import { codexPolicy, threadSettings } from '../provider-settings'
import { readCodexModels } from '../models'
import { describeCodexItem } from './activity'
import { codexPlan } from './todos'
import { findTool, runTool, toolJsonSchema, tools } from '../tools'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const string = (value: unknown) => (typeof value === 'string' ? value : '')

export const runCodex: Runner = async (ctx) => {
  ctx.signal.throwIfAborted()
  let turnId: string | undefined
  let finished = false
  let succeed!: () => void
  let fail!: (error: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    succeed = resolve
    fail = reject
  })
  void done.catch(() => {})
  const client = openCodexClient({
    cwd: ctx.thread.cwd,
    onError: (error) => {
      if (!finished) fail(error)
    },
    onEvent: (packet) => {
      const params = object(packet.params)
      if (packet.id !== undefined && packet.method) {
        const id = packet.id
        if (packet.method.endsWith('/requestApproval')) {
          const command = params.command ?? params.reason ?? params.reasoning ?? params
          void ctx
            .approve({
              id: String(id),
              title: packet.method.includes('fileChange')
                ? 'Allow file changes?'
                : 'Allow this command?',
              detail: typeof command === 'string' ? command : JSON.stringify(command, null, 2),
            })
            .then((allow) =>
              client.send({ id, result: { decision: allow ? 'accept' : 'decline' } }),
            )
            .catch(() => client.send({ id, result: { decision: 'decline' } }))
        } else if (packet.method === 'item/tool/call') {
          // One of t3 mini's tools (show_image…), declared as dynamicTools at thread/start.
          void callTool(id, params)
        } else {
          client.send({
            id,
            error: { code: -32601, message: 'This request is not supported by t3 mini.' },
          })
        }
        return
      }
      if (packet.method === 'turn/started') turnId = string(object(params.turn).id)
      // Codex's plan, shown as the to-do checklist card.
      if (packet.method === 'turn/plan/updated') {
        ctx.todos?.(codexPlan(params))
        ctx.activity({
          id: `plan:${turnId || 'turn'}`,
          label: 'Update plan',
          status: 'completed',
          todo: true,
        })
      }
      if (packet.method === 'item/agentMessage/delta')
        ctx.text(string(params.itemId), string(params.delta))
      if (packet.method === 'item/started' || packet.method === 'item/completed') {
        const item = object(params.item)
        const id = string(item.id)
        const type = string(item.type)
        if (
          type === 'agentMessage' &&
          packet.method === 'item/completed' &&
          typeof item.text === 'string'
        )
          ctx.text(id, item.text, true)
        // Codex's built-in image generator: show the picture in the reply.
        if (type === 'imageGeneration' && packet.method === 'item/completed')
          savingImages.push(showGeneratedImage(item))
        if (
          [
            'commandExecution',
            'fileChange',
            'mcpToolCall',
            'dynamicToolCall',
            'imageGeneration',
            'webSearch',
            'reasoning',
          ].includes(type)
        ) {
          ctx.activity({
            id,
            ...describeCodexItem(item, ctx.thread.cwd, {
              refName: (ref) => ctx.tools.browser?.refName(ref),
            }),
            status:
              packet.method === 'item/started'
                ? 'running'
                : item.status === 'failed'
                  ? 'failed'
                  : 'completed',
          })
        }
      }
      if (packet.method === 'turn/completed') {
        const turn = object(params.turn)
        finished = true
        if (turn.status === 'completed') succeed()
        else
          fail(
            new Error(
              string(object(turn.error).message) ||
                `Codex turn ${string(turn.status) || 'failed'}.`,
            ),
          )
      }
    },
  })
  // Answers Codex's item/tool/call with the same runner the Claude adapter uses. Tools marked
  // 'approval' go through Allow once / Decline first.
  async function callTool(id: string | number, params: Record<string, unknown>) {
    const reply = (success: boolean, text: string, image?: { data: string; mimeType: string }) =>
      client.send({
        id,
        result: {
          success,
          contentItems: [
            { type: 'inputText', text },
            // A screenshot the agent asked for, so it can see the page.
            ...(image
              ? [{ type: 'inputImage', imageUrl: `data:${image.mimeType};base64,${image.data}` }]
              : []),
          ],
        },
      })
    const definition = findTool(string(params.tool))
    if (!definition) return reply(false, `Unknown tool: ${string(params.tool) || '(none)'}.`)
    // 'approval' tools ask first, unless the thread runs with full access (no prompts).
    if (definition.safety === 'approval' && ctx.thread.permissionMode !== 'full-access') {
      const allowed = await ctx
        .approve({
          id: String(id),
          title: `Allow ${definition.label}?`,
          detail: JSON.stringify(params.arguments ?? {}, null, 2),
        })
        .catch(() => false)
      if (!allowed) return reply(false, 'The user declined this tool request.')
    }
    const result = await runTool(definition, ctx.tools, params.arguments)
    reply(result.ok, result.text, result.image)
  }
  // Images Codex generates itself arrive as an imageGeneration item with the image data
  // (base64) and/or the file Codex saved under ~/.codex/generated_images. Only that folder is
  // read, and the bytes go through the same checks as uploads.
  async function showGeneratedImage(item: Record<string, unknown>) {
    if (item.status === 'failed' || item.failure) return
    const fromData = async () => {
      const data = string(item.result).replace(/^data:image\/[a-z+.-]+;base64,/i, '')
      return data ? Buffer.from(data, 'base64') : undefined
    }
    const fromFile = async () => {
      if (!string(item.savedPath)) return undefined
      const root = await realpath(join(homedir(), '.codex', 'generated_images'))
      const file = await realpath(string(item.savedPath))
      return file.startsWith(root + sep) ? readFile(file) : undefined
    }
    for (const source of [fromData, fromFile]) {
      try {
        const bytes = await source()
        if (!bytes?.length) continue
        const { id } = await ctx.tools.saveImage(bytes)
        const caption = string(item.revisedPrompt).slice(0, 300)
        ctx.tools.attach({ type: 'image', id, ...(caption ? { caption } : {}) })
        return
      } catch {
        // Not a usable image from this source (or too large); try the next one.
      }
    }
  }
  // Generated images still being saved; the turn waits for them before it ends.
  const savingImages: Promise<void>[] = []
  const abort = () => {
    if (turnId && ctx.thread.sessionId)
      client.send({
        method: 'turn/interrupt',
        id: 'interrupt',
        params: { threadId: ctx.thread.sessionId, turnId },
      })
    fail(new Error('Turn stopped.'))
    client.close()
  }
  ctx.signal.addEventListener('abort', abort, { once: true })
  const settings = threadSettings(ctx.thread)
  const policy = codexPolicy(settings.permissionMode)
  try {
    await client.initialize()
    ctx.signal.throwIfAborted()
    let model = settings.model || null
    let effort = settings.effort || null
    if (!model || !effort) {
      const [models, configuration] = await Promise.all([
        readCodexModels(client),
        !model ? client.request('config/read', { includeLayers: false }) : Promise.resolve(null),
      ])
      const config = object(object(configuration).config)
      model ||= string(config.model) || models.find((item) => item.isDefault)?.id || null
      effort ||=
        models.find((item) => item.id === model)?.defaultEffort ||
        string(config.model_reasoning_effort) ||
        null
    }
    const result = object(
      await client.request(ctx.thread.sessionId ? 'thread/resume' : 'thread/start', {
        ...(ctx.thread.sessionId
          ? { threadId: ctx.thread.sessionId }
          : // Codex saves these with the thread (session dynamic_tools), so resumed turns
            // keep them; they can only be declared when the thread starts.
            {
              dynamicTools: tools.map((definition) => ({
                type: 'function',
                name: definition.name,
                description: definition.description,
                inputSchema: toolJsonSchema(definition),
              })),
            }),
        cwd: ctx.thread.cwd,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandbox: policy.sandbox,
        model,
      }),
    )
    const threadId = string(object(result.thread).id)
    if (!threadId) throw new Error('Codex returned no thread ID.')
    ctx.session(threadId)
    ctx.signal.throwIfAborted()
    // Editing a stopped turn: drop it (and anything after) from Codex's history first. If Codex
    // can't, the edit still goes out, as a follow-up, and the service notes that.
    if (ctx.rewind?.codexTurn && ctx.thread.sessionId) {
      try {
        await client.request('thread/revert', { threadId, beforeTurnId: ctx.rewind.codexTurn })
        ctx.rewound?.(true)
      } catch {
        ctx.rewound?.(false)
      }
      ctx.signal.throwIfAborted()
    }
    const resultTurn = object(
      await client.request('turn/start', {
        threadId,
        input: [
          ...ctx.images.map((image) => ({ type: 'localImage', path: image.path })),
          ...(ctx.prompt ? [{ type: 'text', text: ctx.prompt }] : []),
        ],
        model,
        effort,
        // Per turn, like model and effort: the thread's saved choice is the source of truth.
        ...(settings.serviceTier ? { serviceTierForTurn: settings.serviceTier } : {}),
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandboxPolicy: policy.sandboxPolicy,
      }),
    )
    turnId = string(object(resultTurn.turn).id)
    if (turnId) ctx.turnStarted?.(turnId)
    // Messages sent while this turn runs go into it with turn/steer. If Codex refuses (the turn
    // just ended, or can't take steering right now), the service queues them as the next turn.
    ctx.onSteer?.(async ({ prompt, images }) => {
      if (finished || !turnId) return false
      try {
        await client.request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          input: [
            ...images.map((image) => ({ type: 'localImage', path: image.path })),
            ...(prompt ? [{ type: 'text', text: prompt }] : []),
          ],
        })
        return true
      } catch {
        return false
      }
    })
    await done
    await Promise.all(savingImages)
  } finally {
    ctx.signal.removeEventListener('abort', abort)
    client.close()
  }
}
