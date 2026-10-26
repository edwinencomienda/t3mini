// Benchmark: what live updates cost the server while a reply streams.
//
//   bun bench/live-updates.ts [tabs] [updates] [patch|full]
//
// Builds a synthetic data folder (no real data): 150 threads, one of them long (400 messages,
// about 300 KB), opens `tabs` live-update streams (/api/events) on the long thread through the
// real route, then streams a reply into it: `updates` notifications, like ten a second for a
// minute by default. Reports server CPU per update, bytes sent per update, memory, and what one
// tab's browser spends on each update (parse, apply the patch, keep unchanged messages). `full`
// is the old way: the whole open thread on every update.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tabs = Number(process.argv[2] || 3)
const updates = Number(process.argv[3] || 600)
const mode = process.argv[4] === 'full' ? 'full' : 'patch'

const directory = await mkdtemp(join(tmpdir(), 't3-mini-bench-'))
process.env.T3_MINI_DATA_DIR = directory
const now = Date.now()
const iso = (offset: number) => new Date(now - offset * 1000).toISOString()
const paragraph =
  'The change keeps the existing behaviour and adds a fallback when the first attempt fails. ' +
  'Tests cover both paths, and the docs mention the new setting. '
const message = (index: number, role: 'user' | 'assistant', length: number) => ({
  id: `m${index}`,
  role,
  text: paragraph.repeat(Math.max(1, Math.round(length / paragraph.length))),
  createdAt: iso(10_000 - index),
  ...(role === 'assistant' ? { turn: `t${Math.floor(index / 4)}` } : {}),
})
const thread = (index: number, messages: number) => ({
  id: `thread-${index}`,
  title: `Thread ${index}`,
  provider: 'claude',
  cwd: directory,
  model: 'opus',
  effort: 'medium',
  permissionMode: 'default',
  status: 'completed',
  createdAt: iso(100_000 + index),
  updatedAt: iso(index),
  messages: Array.from({ length: messages }, (_, m) =>
    message(m, m % 4 === 0 ? 'user' : 'assistant', m % 4 === 3 ? 2400 : 300),
  ),
  activities: [],
  approvals: [],
})
const threads = [thread(0, 400), ...Array.from({ length: 149 }, (_, i) => thread(i + 1, 24))]
await writeFile(join(directory, 'threads.json'), JSON.stringify(threads))
await writeFile(join(directory, 'projects.json'), JSON.stringify([]))

const { handleApi } = await import('../src/server/api')
const { getService } = await import('../src/server/service')
const service = await getService()
const open = service.get('thread-0')
const origin = 'http://localhost:4016'

// Open the tabs and drain what they receive.
let bytes = 0
// What the first tab received, replayed afterwards as the browser would handle it.
const received: string[] = []
const decoder = new TextDecoder()
const controllers: AbortController[] = []
for (let tab = 0; tab < tabs; tab++) {
  const abort = new AbortController()
  controllers.push(abort)
  const response = await handleApi(
    new Request(`${origin}/api/events?thread=thread-0${mode === 'patch' ? '&patch=1' : ''}`, {
      signal: abort.signal,
    }),
  )
  void (async () => {
    const reader = response.body!.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (tab === 0 && !process.env.NO_REPLAY)
          received.push(decoder.decode(value, { stream: true }))
      }
    } catch {
      /* Closed. */
    }
  })()
}
await new Promise((resolve) => setTimeout(resolve, 200))

// A reply streaming in: a new message grows a few words at a time.
const reply = { ...message(400, 'assistant', 0), text: '' }
open.messages.push(reply)
open.status = 'working'
const notify = () => (service as unknown as { notify(): void }).notify()
const gc = () => (globalThis as { Bun?: { gc(sync: boolean): void } }).Bun?.gc(true)
gc()
const before = process.memoryUsage()
bytes = 0
const cpu = process.cpuUsage()
const started = performance.now()
for (let update = 0; update < updates; update++) {
  reply.text += 'More of the answer arrives here, a few words at a time. '
  open.updatedAt = new Date().toISOString()
  notify()
  // Let the streams flush, like the real 100 ms batching does between updates.
  await new Promise((resolve) => setImmediate(resolve))
}
const elapsed = performance.now() - started
const used = process.cpuUsage(cpu)
await new Promise((resolve) => setTimeout(resolve, 100))
const after = process.memoryUsage()
gc()
const settled = process.memoryUsage()

// One tab's browser work: parse each update, apply it, keep unchanged messages (reuse.ts).
const { reuseThread } = await import('../src/reuse')
const { applyThreadPatch } = await import('../src/thread-patch')
const events = received
  .join('')
  .split('\n\n')
  .filter((chunk) => chunk.startsWith('data: '))
const browserStarted = performance.now()
let current: import('../src/types').Thread | null = null
for (const event of events) {
  const data = JSON.parse(event.slice(6)) as {
    thread?: import('../src/types').Thread | null
    threadPatch?: import('../src/thread-patch').ThreadPatch
  }
  const next = data.threadPatch
    ? applyThreadPatch(current!, data.threadPatch)
    : data.thread !== undefined
      ? data.thread
      : current
  current = next ? reuseThread(current, next) : null
}
const browserMs = performance.now() - browserStarted
if (!process.env.NO_REPLAY && current?.messages.at(-1)?.text !== reply.text)
  throw new Error('The browser copy is wrong.')

const mb = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`
console.log(
  JSON.stringify(
    {
      mode,
      tabs,
      updates,
      openThreadKB: Math.round(JSON.stringify(open).length / 1024),
      cpuMsPerUpdate: +((used.user + used.system) / 1000 / updates).toFixed(3),
      wallMs: Math.round(elapsed),
      kbSentPerUpdate: +(bytes / 1024 / updates).toFixed(1),
      browserMsPerUpdate: +(browserMs / Math.max(1, events.length - 1)).toFixed(3),
      rss: mb(settled.rss),
      heapUsedAfterGc: mb(settled.heapUsed),
      heapGrowthDuringStream: mb(after.heapUsed - before.heapUsed),
    },
    null,
    2,
  ),
)
for (const abort of controllers) abort.abort()
await service.close()
await rm(directory, { recursive: true, force: true })
process.exit(0)
