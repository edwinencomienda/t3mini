// The production HTTP server, shared by `node server.mjs` (page files on disk) and the t3mini
// binary (page files embedded, see src/cli). Serves the built page files, hands everything else
// to the app, and wires the dictation WebSocket. Loopback only.
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extname } from 'node:path'
import {
  brotliCompressSync,
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
  gzipSync,
} from 'node:zlib'

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
const compressibleExt = new Set(['.js', '.css', '.svg', '.json', '.webmanifest', '.html', '.txt'])
const minCompressBytes = 1024
const pickEncoding = (header) => {
  if (!header) return null
  if (/\bbr\b/i.test(header)) return 'br'
  if (/\bgzip\b/i.test(header)) return 'gzip'
  return null
}
const isCompressibleType = (type) => {
  if (!type) return false
  const lower = type.toLowerCase()
  if (lower.startsWith('text/event-stream')) return false
  return (
    lower.startsWith('text/') ||
    lower.startsWith('application/json') ||
    lower.startsWith('application/javascript') ||
    lower.startsWith('image/svg+xml')
  )
}
const compressBuffer = (buf, encoding) =>
  encoding === 'br'
    ? brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
    : gzipSync(buf, { level: 6 })
const compressStream = (encoding) =>
  encoding === 'br'
    ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
    : createGzip({ level: 4 })
const streamToBuffer = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

// app: the built app (dist/server/server.js). staticFile(pathname): a page file's contents
// (a Buffer or a readable stream, opened on demand), or null when there's none at that path.
export function startAppServer({ app, port, staticFile, label = 't3 mini' }) {
  // Compressed immutable /assets/* buffers, cached so reloads and phones don't re-compress.
  const compressedAssets = new Map()
  const server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController()
    outgoing.on('close', () => abort.abort())
    try {
      const url = new URL(
        incoming.url || '/',
        `http://${incoming.headers.host || `127.0.0.1:${port}`}`,
      )
      const encoding = pickEncoding(incoming.headers['accept-encoding'])
      if (incoming.method === 'GET' || incoming.method === 'HEAD') {
        const open = await staticFile(decodeURIComponent(url.pathname))
        if (open) {
          const ext = extname(url.pathname)
          const immutable = url.pathname.startsWith('/assets/')
          const baseHeaders = {
            'Content-Type': mime[ext] || 'application/octet-stream',
            'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          }
          const canCompress = Boolean(encoding && compressibleExt.has(ext))
          if (incoming.method === 'HEAD') {
            outgoing.writeHead(
              200,
              canCompress ? { ...baseHeaders, Vary: 'Accept-Encoding' } : baseHeaders,
            )
            return outgoing.end()
          }
          if (canCompress) {
            const cacheKey = immutable ? `${url.pathname}:${encoding}` : null
            let compressed = cacheKey ? compressedAssets.get(cacheKey) : undefined
            if (!compressed) {
              const raw = await open()
              const buf = Buffer.isBuffer(raw) ? raw : await streamToBuffer(raw)
              if (buf.byteLength < minCompressBytes) {
                outgoing.writeHead(200, {
                  ...baseHeaders,
                  'Content-Length': String(buf.byteLength),
                })
                return outgoing.end(buf)
              }
              compressed = compressBuffer(buf, encoding)
              if (cacheKey) {
                if (compressedAssets.size > 200)
                  compressedAssets.delete(compressedAssets.keys().next().value)
                compressedAssets.set(cacheKey, compressed)
              }
            }
            outgoing.writeHead(200, {
              ...baseHeaders,
              'Content-Encoding': encoding,
              'Content-Length': String(compressed.byteLength),
              Vary: 'Accept-Encoding',
            })
            return outgoing.end(compressed)
          }
          outgoing.writeHead(200, baseHeaders)
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
      const outHeaders = Object.fromEntries(response.headers)
      const contentLength = Number(response.headers.get('content-length') || 0)
      const shouldCompress =
        Boolean(encoding) &&
        incoming.method !== 'HEAD' &&
        Boolean(response.body) &&
        response.status !== 204 &&
        response.status !== 206 &&
        response.status !== 304 &&
        !response.headers.get('content-encoding') &&
        isCompressibleType(response.headers.get('content-type')) &&
        (!contentLength || contentLength >= minCompressBytes)
      if (shouldCompress) {
        delete outHeaders['content-length']
        outHeaders['content-encoding'] = encoding
        outHeaders.vary = outHeaders.vary
          ? `${outHeaders.vary}, Accept-Encoding`
          : 'Accept-Encoding'
        outgoing.writeHead(response.status, outHeaders)
        await pipeline(Readable.fromWeb(response.body), compressStream(encoding), outgoing)
      } else {
        outgoing.writeHead(response.status, outHeaders)
        if (response.body && incoming.method !== 'HEAD')
          await pipeline(Readable.fromWeb(response.body), outgoing)
        else outgoing.end()
      }
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
