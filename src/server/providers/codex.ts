import type { Runner } from './types'
import { openCodexClient } from './codex-client'
import { codexPolicy, threadSettings } from '../provider-settings'
import { readCodexModels } from '../models'
import { describeCodexItem } from './activity'

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
          ctx.activity({
            id,
            ...describeCodexItem(item, ctx.thread.cwd),
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
  } finally {
    ctx.signal.removeEventListener('abort', abort)
    client.close()
  }
}
