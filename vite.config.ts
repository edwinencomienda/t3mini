import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'

// Live dictation's WebSocket (/api/dictation/stream) goes to the handler the app registered on
// globalThis (src/server/dictation-stream.ts). Other upgrades, like Vite's own live reload, are
// left alone. server.mjs does the same in production.
const dictationStream: Plugin = {
  name: 't3-mini-dictation-stream',
  configureServer(server) {
    server.httpServer?.on('upgrade', (request, socket, head) => {
      if (!request.url?.startsWith('/api/dictation/stream')) return
      const handle = (globalThis as { t3MiniDictationUpgrade?: Function }).t3MiniDictationUpgrade
      if (handle) handle(request, socket, head)
      else socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    })
  },
}
export default defineConfig({ plugins: [tanstackStart(), react(), dictationStream] })
