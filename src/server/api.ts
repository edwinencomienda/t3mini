import { z } from 'zod'
import { getService, HttpError } from './service'
import { pickProjectFolder } from './folder-picker'
import { getModels } from './models'

// This application launches local agents. Keep every endpoint loopback-only and same-origin.
export function checkRequest(request: Request) {
  const url = new URL(request.url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new HttpError(403, 't3 mini is available only on localhost.')
  const origin = request.headers.get('origin')
  if (origin && origin !== url.origin)
    throw new HttpError(403, 'Cross-origin requests are not allowed.')
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new HttpError(403, 'Cross-site requests are not allowed.')
  if (
    request.method !== 'GET' &&
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    throw new HttpError(415, 'Expected application/json.')
}
export async function handleApi(request: Request) {
  try {
    checkRequest(request)
    const service = await getService()
    const url = new URL(request.url),
      parts = url.pathname.split('/').filter(Boolean).slice(1)
    if (parts[0] === 'folders' && parts[1] === 'pick' && request.method === 'POST')
      return Response.json(await pickProjectFolder(await request.json()))
    if (parts[0] === 'models' && request.method === 'GET') {
      const provider = z.enum(['codex', 'claude']).parse(url.searchParams.get('provider'))
      try {
        return Response.json({
          models: await getModels(
            provider,
            url.searchParams.get('cwd') || undefined,
            url.searchParams.get('refresh') === '1',
          ),
        })
      } catch {
        return Response.json({
          models: [],
          error:
            'Could not load models from this provider. Check your CLI installation and sign-in, or use Provider default.',
        })
      }
    }
    if (parts[0] === 'projects' && !parts[1]) {
      if (request.method === 'POST')
        return Response.json(await service.addProject(await request.json()), { status: 201 })
      if (request.method === 'DELETE')
        return Response.json(await service.removeProject(await request.json()))
    }
    if (parts[0] === 'bootstrap' && request.method === 'GET')
      return Response.json(await service.bootstrap())
    if (parts[0] === 'events' && request.method === 'GET') {
      const id = url.searchParams.get('thread') || undefined
      if (id) service.get(id)
      let cleanup = () => {}
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encode = new TextEncoder()
          const push = () => {
            try {
              controller.enqueue(encode.encode(`data: ${JSON.stringify(service.snapshot(id))}\n\n`))
            } catch {
              cleanup()
            }
          }
          const unsubscribe = service.subscribe(push)
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encode.encode(': keepalive\n\n'))
            } catch {
              cleanup()
            }
          }, 15_000)
          cleanup = () => {
            unsubscribe()
            clearInterval(heartbeat)
            request.signal.removeEventListener('abort', close)
          }
          const close = () => {
            cleanup()
            try {
              controller.close()
            } catch {
              /* Already closed. */
            }
          }
          request.signal.addEventListener('abort', close, { once: true })
          if (request.signal.aborted) close()
          else push()
        },
        cancel() {
          cleanup()
        },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      })
    }
    if (parts[0] === 'threads') {
      if (!parts[1] && request.method === 'POST')
        return Response.json(await service.create(await request.json()), { status: 201 })
      const id = parts[1]
      if (id && !parts[2] && request.method === 'GET') return Response.json(service.get(id))
      if (id && parts[2] === 'git' && request.method === 'GET')
        return Response.json(await service.gitInfo(id))
      if (id && !parts[2] && request.method === 'DELETE')
        return Response.json(await service.remove(id))
      if (id && request.method === 'POST') {
        if (parts[2] === 'settings')
          return Response.json(await service.updateSettings(id, await request.json()))
        if (parts[2] === 'send')
          return Response.json(await service.send(id, await request.json()), { status: 202 })
        if (parts[2] === 'rename')
          return Response.json(await service.rename(id, await request.json()))
        if (parts[2] === 'stop') return Response.json(await service.stop(id))
        if (parts[2] === 'approve') {
          const data = z
            .object({ approvalId: z.string(), allow: z.boolean() })
            .parse(await request.json())
          return Response.json(service.approve(id, data.approvalId, data.allow))
        }
      }
    }
    throw new HttpError(404, 'Endpoint not found.')
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : 500
    const message =
      error instanceof HttpError
        ? error.message
        : status === 400
          ? 'Invalid request. Check your input.'
          : 'The server could not complete the request.'
    return Response.json({ error: message }, { status })
  }
}
