import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import app from './dist/server/server.js'

const port = Number(process.env.PORT || 4310)
const assets = resolve('dist/client')
const mime = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}
const server = createServer(async (incoming, outgoing) => {
  const abort = new AbortController()
  outgoing.on('close', () => abort.abort())
  try {
    const url = new URL(
      incoming.url || '/',
      `http://${incoming.headers.host || `127.0.0.1:${port}`}`,
    )
    const filename = resolve(assets, '.' + decodeURIComponent(url.pathname))
    if (
      (incoming.method === 'GET' || incoming.method === 'HEAD') &&
      filename.startsWith(assets + sep)
    ) {
      const info = await stat(filename).catch(() => null)
      if (info?.isFile()) {
        outgoing.writeHead(200, {
          'Content-Type': mime[extname(filename)] || 'application/octet-stream',
          'Cache-Control': url.pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        })
        if (incoming.method === 'HEAD') outgoing.end()
        else await pipeline(createReadStream(filename), outgoing)
        return
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
// Live dictation's WebSocket goes to the handler the app registered (src/server/dictation-stream.ts);
// there are no other WebSockets in production.
server.on('upgrade', (request, socket, head) => {
  const handle = globalThis.t3MiniDictationUpgrade
  if (request.url?.startsWith('/api/dictation/stream') && handle) handle(request, socket, head)
  else socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
})
server.listen(port, '127.0.0.1', () => console.log(`t3 mini → http://localhost:${port}`))
