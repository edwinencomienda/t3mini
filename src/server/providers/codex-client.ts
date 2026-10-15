import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'

const packetSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
})
export type CodexPacket = z.infer<typeof packetSchema>
export function openCodexClient(options: {
  cwd: string
  onEvent?: (packet: CodexPacket) => void
  onError?: (error: Error) => void
}) {
  const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--listen', 'stdio://'], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  let sequence = 0
  let closed = false
  let failure: Error | undefined
  const pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  const fail = (error: Error) => {
    failure = error
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
    if (!closed) options.onError?.(error)
  }
  const send = (packet: unknown) => {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(packet) + '\n')
  }
  child.on('error', () =>
    fail(new Error('Could not start Codex. Install the CLI and sign in with codex login.')),
  )
  child.stdin.on('error', () => fail(new Error('Codex connection closed.')))
  child.on('exit', (code) =>
    fail(
      new Error(
        `Codex exited before completing the request${code === null ? '' : ` (code ${code})`}.`,
      ),
    ),
  )
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }
    const result = packetSchema.safeParse(raw)
    if (!result.success) return
    const packet = result.data
    if (packet.id !== undefined && !packet.method) {
      const item = pending.get(packet.id)
      if (item) {
        pending.delete(packet.id)
        clearTimeout(item.timer)
        packet.error ? item.reject(new Error(packet.error.message)) : item.resolve(packet.result)
      }
    } else options.onEvent?.(packet)
  })
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (failure || closed) {
        reject(failure || new Error('Codex connection closed.'))
        return
      }
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex did not respond to ${method}.`))
      }, 20_000)
      pending.set(id, { resolve, reject, timer })
      send({ id, method, params })
    })
  return {
    request,
    send,
    async initialize() {
      await request('initialize', {
        clientInfo: { name: 't3_mini', title: 'T3 Mini', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      send({ method: 'initialized', params: {} })
    },
    close() {
      closed = true
      fail(new Error('Codex connection closed.'))
      lines.close()
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 2_000)
        timer.unref()
        child.once('exit', () => clearTimeout(timer))
      }
    },
  }
}
