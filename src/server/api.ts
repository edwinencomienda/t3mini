import { z } from 'zod'
import { getService, HttpError } from './service'
import { pickProjectFolder } from './folder-picker'
import { getModels } from './models'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode'
import { getRemoteAccess, remoteHeader } from './remote'

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
    // Set only by the phone-access gateway, which strips it from what the phone sends.
    const remote = request.headers.get(remoteHeader) === '1'
    const macOnly = (what: string) => {
      if (remote) throw new HttpError(403, `${what} is only available on the Mac running t3 mini.`)
    }
    if (parts[0] === 'remote') {
      macOnly('Managing phone access')
      const access = await getRemoteAccess(join(dirname(service.store.path), 'devices.json'))
      if (!parts[1] && request.method === 'GET') return Response.json(access.status())
      if (!parts[1] && request.method === 'POST') {
        const { enabled } = z.object({ enabled: z.boolean() }).parse(await request.json())
        try {
          if (enabled) await access.enable(Number(url.port) || 80)
          else await access.disable()
        } catch {
          throw new HttpError(
            500,
            `Could not start phone access on port ${access.port}. Is another app using it?`,
          )
        }
        return Response.json(access.status())
      }
      if (parts[1] === 'pair' && request.method === 'POST') {
        let pairing
        try {
          pairing = access.createPairing()
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : 'Phone access is off.')
        }
        const links = await Promise.all(
          pairing.urls.map(async (link) => ({
            url: link,
            qr: await QRCode.toDataURL(link, { margin: 1, width: 240 }),
          })),
        )
        return Response.json({ expiresAt: pairing.expiresAt, links })
      }
      if (parts[1] === 'devices' && request.method === 'DELETE') {
        const { id } = z.object({ id: z.string().optional() }).parse(await request.json())
        await access.revoke(id)
        return Response.json(access.status())
      }
    }
    if (parts[0] === 'folders' && parts[1] === 'pick' && request.method === 'POST') {
      macOnly('Browsing folders')
      return Response.json(await pickProjectFolder(await request.json()))
    }
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
    if (parts[0] === 'uploads') {
      if (!parts[1] && request.method === 'POST') {
        // Reject oversized bodies before reading them (25 MB file as base64, plus JSON).
        const length = Number(request.headers.get('content-length') || 0)
        if (length > 36 * 1024 * 1024) throw new HttpError(413, 'Files can be up to 25 MB.')
        return Response.json(await service.upload(await request.json()), { status: 201 })
      }
      // Only saved images are served (by generated id), with no sniffing and no scripts.
      if (parts[1] && !parts[2] && request.method === 'GET') {
        try {
          const { bytes, mimeType } = await service.uploads.read(parts[1])
          return new Response(new Uint8Array(bytes), {
            headers: {
              'Content-Type': mimeType,
              'Cache-Control': 'private, max-age=31536000, immutable',
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'",
            },
          })
        } catch {
          throw new HttpError(404, 'Image not found.')
        }
      }
    }
    if (parts[0] === 'projects' && !parts[1]) {
      if (request.method === 'POST')
        return Response.json(await service.addProject(await request.json()), { status: 201 })
      if (request.method === 'DELETE')
        return Response.json(await service.removeProject(await request.json()))
    }
    if (parts[0] === 'bootstrap' && request.method === 'GET') {
      const access = await getRemoteAccess(join(dirname(service.store.path), 'devices.json'))
      // remote: this page runs on a paired phone, so Mac-only actions are hidden.
      return Response.json({ ...(await service.bootstrap()), remote, phoneAccess: access.enabled })
    }
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
      if (id && parts[2] === 'diff' && !parts[3] && request.method === 'GET')
        return Response.json(await service.diff(id))
      if (id && parts[2] === 'diff' && parts[3] === 'version' && request.method === 'GET')
        return Response.json(await service.diffVersion(id))
      if (id && !parts[2] && request.method === 'DELETE')
        return Response.json(await service.remove(id))
      if (id && request.method === 'POST') {
        if (parts[2] === 'settings')
          return Response.json(await service.updateSettings(id, await request.json()))
        if (parts[2] === 'send')
          return Response.json(await service.send(id, await request.json()), { status: 202 })
        if (parts[2] === 'open-editor') {
          macOnly('Opening VS Code')
          return Response.json(await service.openInEditor(id))
        }
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
