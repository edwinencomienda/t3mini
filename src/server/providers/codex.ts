import type { Runner } from './types'
import { openCodexClient } from './codex-client'
import { codexPolicy, threadSettings } from '../provider-settings'
import { readCodexModels } from '../models'

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
        } else {
          client.send({
            id,
            error: { code: -32601, message: 'This request is not supported by t3 mini.' },
          })
        }
        return
      }
      if (packet.method === 'turn/started') turnId = string(object(params.turn).id)
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
        if (
          ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'reasoning'].includes(type)
        ) {
          const label =
            type === 'commandExecution'
              ? 'Run command'
              : type === 'fileChange'
                ? 'Edit files'
                : type === 'reasoning'
                  ? 'Thinking'
                  : type === 'webSearch'
                    ? 'Search the web'
                    : 'Use tool'
          ctx.activity({
            id,
            label,
            detail: string(item.command) || undefined,
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
        ...(ctx.thread.sessionId ? { threadId: ctx.thread.sessionId } : {}),
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
    const resultTurn = object(
      await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: ctx.prompt }],
        model,
        effort,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandboxPolicy: policy.sandboxPolicy,
      }),
    )
    turnId = string(object(resultTurn.turn).id)
    await done
  } finally {
    ctx.signal.removeEventListener('abort', abort)
    client.close()
  }
}
