import { z } from 'zod'
import { isActive } from '../types'
import { getService, HttpError } from './service'
import { pickProjectFolder } from './folder-picker'
import { getModels } from './models'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode'
import { getRemoteAccess, remoteHeader } from './remote'
import { tailscaleStatus } from './tailscale'
import { providerAccount } from './accounts'
import {
  clearDictationKey,
  dictationAvailable,
  dictationStatus,
  loadDictationKey,
  maxAudioBytes,
  saveDictationKey,
  transcribe,
  transcriptionThread,
} from './dictation'
import { registerDictationStream } from './dictation-stream'
import { providerUpdates, updateProvider } from './cli-updates'

// Live dictation is a WebSocket, which the HTTP servers route to this module (see vite.config.ts
// and server.mjs).
registerDictationStream()

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
// Checked by shape, not instanceof: in dev the long-lived service was created by an earlier
// copy of service.ts, so after a hot reload its HttpError is a different class than the one
// imported here, and instanceof would turn every 404/409 into a generic 500.
export function isHttpError(error: unknown): error is HttpError {
  return (
    error instanceof Error &&
    ['HttpError', 'DictationError', 'UpdateError'].some(
      (name) => error.name === name || error.constructor.name === name,
    ) &&
    typeof (error as { status?: unknown }).status === 'number'
  )
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
    const secretsPath = join(dirname(service.store.path), 'secrets.json')
    await loadDictationKey(secretsPath)
    // The Deepgram key is managed from the Mac only, and never returned.
    if (parts[0] === 'dictation' && !parts[1]) {
      macOnly('Managing the dictation key')
      if (request.method === 'GET') return Response.json(dictationStatus())
      if (request.method === 'POST')
        return Response.json(await saveDictationKey(secretsPath, await request.json()))
      if (request.method === 'DELETE') return Response.json(await clearDictationKey(secretsPath))
    }
    if (parts[0] === 'transcribe' && !parts[1] && request.method === 'POST') {
      // base64 + JSON overhead on top of the audio limit; refuse bigger bodies before reading.
      const length = Number(request.headers.get('content-length') || 0)
      if (length > Math.ceil(maxAudioBytes * 1.4))
        throw new HttpError(413, 'The recording is too long.')
      const body = await request.json()
      const thread = transcriptionThread(body)
      return Response.json(
        await transcribe(body, thread ? await service.dictationKeyterms(thread) : []),
      )
    }
    // Long-running processes agents started (the list itself comes with the live updates).
    if (parts[0] === 'processes' && parts[1]) {
      const info = service.processes.get(parts[1])
      if (!info) throw new HttpError(404, 'Process not found.')
      if (parts[2] === 'logs' && request.method === 'GET') {
        const lines = Number(url.searchParams.get('lines')) || 500
        return Response.json({ logs: service.processes.logs(info.id, lines) ?? '' })
      }
      if (parts[2] === 'stop' && request.method === 'POST')
        return Response.json(await service.processes.stop(info.id))
      if (parts[2] === 'restart' && request.method === 'POST')
        return Response.json(await service.processes.restart(info.id))
      if (!parts[2] && request.method === 'DELETE') {
        try {
          service.processes.remove(info.id)
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : 'Stop it first.')
        }
        return Response.json({ ok: true })
      }
    }
    if (parts[0] === 'remote') {
      macOnly('Managing phone access')
      const access = await getRemoteAccess(join(dirname(service.store.path), 'devices.json'))
      // Status plus whether Tailscale can be used (installed, signed in, its tailnet name).
      const status = async () => ({ ...access.status(), tailscale: await tailscaleStatus() })
      if (!parts[1] && request.method === 'GET') return Response.json(await status())
      if (!parts[1] && request.method === 'POST') {
        const { enabled, mode } = z
          .object({ enabled: z.boolean(), mode: z.enum(['lan', 'tailscale']).default('lan') })
          .parse(await request.json())
        try {
          if (enabled) await access.enable(Number(url.port) || 80, mode)
          else await access.disable()
        } catch (error) {
          throw new HttpError(
            500,
            (error as NodeJS.ErrnoException).code === 'EADDRINUSE' || !(error instanceof Error)
              ? `Could not start phone access on port ${access.port}. Is another app using it?`
              : error.message,
          )
        }
        return Response.json(await status())
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
        return Response.json(await status())
      }
    }
    // Provider CLI updates change software on the Mac, so they're never offered to a phone.
    if (parts[0] === 'provider-updates') {
      macOnly('Updating agents')
      if (!parts[1] && request.method === 'GET')
        return Response.json({
          updates: await providerUpdates(url.searchParams.get('refresh') === '1'),
        })
      if (parts[1] && !parts[2] && request.method === 'POST') {
        const provider = z.enum(['codex', 'claude']).parse(parts[1])
        const busy = service
          .list()
          .some((thread) => thread.provider === provider && isActive(thread.status))
        return Response.json(await updateProvider(provider, busy))
      }
    }
    if (parts[0] === 'folders' && parts[1] === 'pick' && request.method === 'POST') {
      macOnly('Browsing folders')
      return Response.json(await pickProjectFolder(await request.json()))
    }
    // Who each agent is signed in as (email and plan), for Settings → Agents.
    if (parts[0] === 'providers' && parts[1] === 'accounts' && request.method === 'GET') {
      const refresh = url.searchParams.get('refresh') === '1'
      const [claude, codex] = await Promise.all([
        providerAccount('claude', refresh),
        providerAccount('codex', refresh),
      ])
      return Response.json({ claude, codex })
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
    if (parts[0] === 'projects' && parts[1] === 'rename' && !parts[2] && request.method === 'POST')
      return Response.json(await service.renameProject(await request.json()))
    if (parts[0] === 'projects' && !parts[1]) {
      if (request.method === 'POST')
        return Response.json(await service.addProject(await request.json()), { status: 201 })
      if (request.method === 'DELETE')
        return Response.json(await service.removeProject(await request.json()))
    }
    if (parts[0] === 'bootstrap' && request.method === 'GET') {
      const access = await getRemoteAccess(join(dirname(service.store.path), 'devices.json'))
      // remote: this page runs on a paired phone, so Mac-only actions are hidden.
      return Response.json({
        ...(await service.bootstrap()),
        remote,
        phoneAccess: access.enabled,
        dictation: dictationAvailable(),
      })
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
      if (id && parts[2] === 'pull-request' && request.method === 'GET')
        return Response.json({ pullRequest: await service.pullRequest(id) })
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
        if (parts[2] === 'edit')
          return Response.json(await service.edit(id, await request.json()), { status: 202 })
        if (parts[2] === 'open-editor') {
          macOnly('Opening VS Code')
          return Response.json(await service.openInEditor(id))
        }
        if (parts[2] === 'rename')
          return Response.json(await service.rename(id, await request.json()))
        if (parts[2] === 'title') return Response.json(await service.regenerateTitle(id))
        if (parts[2] === 'stop') return Response.json(await service.stop(id))
        if (parts[2] === 'approve') {
          const data = z
            .object({
              approvalId: z.string(),
              allow: z.boolean(),
              // Answers to an agent's question: question text → chosen option(s) or your words.
              answers: z
                .record(z.string().max(1000), z.string().max(4000))
                .refine((value) => Object.keys(value).length <= 8)
                .optional(),
            })
            .parse(await request.json())
          return Response.json(service.approve(id, data.approvalId, data.allow, data.answers))
        }
      }
    }
    throw new HttpError(404, 'Endpoint not found.')
  } catch (error) {
    const status = isHttpError(error)
      ? error.status
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? 400
        : 500
    const message = isHttpError(error)
      ? error.message
      : status === 400
        ? 'Invalid request. Check your input.'
        : 'The server could not complete the request.'
    return Response.json({ error: message }, { status })
  }
}
