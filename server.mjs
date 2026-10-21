// Production server on Node (`bun run start`): the built app, with page files from dist/client.
// The t3mini binary runs the same server with the files embedded (src/cli/t3mini.ts).
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import app from './dist/server/server.js'
import { startAppServer } from './app-server.mjs'

// Relative to this file, so it can be started from any folder.
const assets = fileURLToPath(new URL('./dist/client', import.meta.url))

startAppServer({
  app,
  port: Number(process.env.PORT || 4011),
  async staticFile(pathname) {
    const filename = resolve(assets, '.' + pathname)
    if (!filename.startsWith(assets + sep)) return null
    const info = await stat(filename).catch(() => null)
    return info?.isFile() ? () => createReadStream(filename) : null
  },
})
