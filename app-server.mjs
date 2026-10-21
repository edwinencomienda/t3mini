// The production HTTP server, shared by `node server.mjs` (page files on disk) and the t3mini
// binary (page files embedded, see src/cli). Serves the built page files, hands everything else
// to the app, and wires the dictation WebSocket. Loopback only.
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extname } from 'node:path'

const mime = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

// app: the built app (dist/server/server.js). staticFile(pathname): a page file's contents
// (a Buffer or a readable stream, opened on demand), or null when there's none at that path.
export function startAppServer({ app, port, staticFile, label = 't3 mini' }) {
  const server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController()
    outgoing.on('close', () => abort.abort())
    try {
      const url = new URL(
        incoming.url || '/',
        `http://${incoming.headers.host || `127.0.0.1:${port}`}`,
      )
      if (incoming.method === 'GET' || incoming.method === 'HEAD') {
        const open = await staticFile(decodeURIComponent(url.pathname))
        if (open) {
          outgoing.writeHead(200, {
            'Content-Type': mime[extname(url.pathname)] || 'application/octet-stream',
            'Cache-Control': url.pathname.startsWith('/assets/')
              ? 'public, max-age=31536000, immutable'
              : 'no-cache',
          })
          if (incoming.method === 'HEAD') return outgoing.end()
          const body = await open()
          if (Buffer.isBuffer(body)) return outgoing.end(body)
          return await pipeline(body, outgoing)
        }
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers))
        if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      const hasBody = !['GET', 'HEAD'].includes(incoming.method || 'GET')
      const request = new Request(url, {
        method: incoming.method,
        headers,
        signal: abort.signal,
        ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
      })
      const response = await app.fetch(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body && incoming.method !== 'HEAD')
        await pipeline(Readable.fromWeb(response.body), outgoing)
      else outgoing.end()
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'text/plain' })
      outgoing.end('The server could not complete this request.')
    }
  })
  // Live dictation's WebSocket goes to the handler the app registered
  // (src/server/dictation-stream.ts); there are no other WebSockets in production.
  server.on('upgrade', (request, socket, head) => {
    const handle = globalThis.t3MiniDictationUpgrade
    if (request.url?.startsWith('/api/dictation/stream') && handle) handle(request, socket, head)
    else socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
  })
  // Stop means stop. Other signal listeners (Playwright adds one once the agents' browser has
  // run) would otherwise keep the server alive; exiting runs the 'exit' hooks, which stop agent
  // dev servers and Tailscale serve.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ])
    process.on(signal, () => process.exit(code))
  server.on('error', (error) => {
    console.error(
      error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use.`
        : `t3 mini couldn’t start: ${error.message}`,
    )
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`${label} → http://127.0.0.1:${port}`)
    // Tailscale phone access that was on before a restart comes back by itself.
    void app
      .fetch(
        new Request(`http://127.0.0.1:${port}/api/remote/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      )
      .catch(() => {})
  })
  return server
}
