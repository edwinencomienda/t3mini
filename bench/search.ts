// Benchmark: what searching inside conversations costs (the sidebar's Search box and ⌘K).
//
//   bun bench/search.ts [scales…]     e.g. bun bench/search.ts 1 10 50
//
// Builds synthetic threads (no real data) at each scale: 1 is about a busy user's data today
// (100 threads, ~5,000 messages, ~2 M characters of text), 10 and 50 are ten and fifty times
// that. Messages are random sentences from a vocabulary of ~2,000 words, with a few planted
// words so rare, common, and missing words can be searched. For each scale it reports the
// time per search through the service (median of repeated runs) for:
//   - a rare word (a handful of threads), a common word (nearly every thread), and a word that
//     matches nothing (the worst case: every message is read);
//   - typing a word one letter at a time, as the sidebar sends it (each longer query only
//     rechecks the threads that matched the shorter one);
//   - the same search again after something changed (the narrowing is reset, so a full scan);
//   - the whole route (/api/search with limit 500: search, excerpts, and JSON), what a tab waits on;
//   - the old way (lowercasing every message, then includes), for comparison;
// and the memory a burst of searches leaves behind (searching keeps no index).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scales = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0)
if (!scales.length) scales.push(1, 10, 50)

// A small seeded random, so every run builds the same data.
let seed = 42
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}
const syllables = ['ka', 're', 'mo', 'ti', 'lu', 'sen', 'dor', 'pa', 'vi', 'ne', 'qua', 'ro']
const vocabulary = Array.from({ length: 2000 }, () =>
  Array.from(
    { length: 2 + Math.floor(random() * 3) },
    () => syllables[Math.floor(random() * syllables.length)],
  ).join(''),
)
// Planted words: "zephyrine" in about 1 thread in 50, "deploy" in nearly every thread.
const sentence = () =>
  Array.from(
    { length: 8 + Math.floor(random() * 10) },
    () => vocabulary[Math.floor(random() * vocabulary.length)],
  ).join(' ') + '. '
const text = (length: number) => {
  let out = ''
  while (out.length < length) out += sentence()
  return out
}

const now = Date.now()
function build(scale: number) {
  const threads = []
  let messages = 0
  let chars = 0
  for (let index = 0; index < 100 * scale; index++) {
    const count = 20 + Math.floor(random() * 60)
    const list = []
    for (let m = 0; m < count; m++) {
      const role = m % 2 ? 'assistant' : 'user'
      let body = text(role === 'user' ? 120 + random() * 200 : 300 + random() * 900)
      if (random() < 0.3) body += 'Then deploy it. '
      if (index % 50 === 7 && m === 3) body += 'The zephyrine flag stays on. '
      list.push({
        id: `t${index}-m${m}`,
        role,
        text: body,
        createdAt: new Date(now - (index * 1000 + count - m) * 1000).toISOString(),
      })
      messages++
      chars += body.length
    }
    threads.push({
      id: `thread-${index}`,
      title: `Thread ${index}`,
      provider: 'claude',
      cwd: '/tmp/bench-project',
      model: '',
      effort: '',
      permissionMode: 'full-access',
      status: 'completed',
      createdAt: new Date(now - index * 1000_000).toISOString(),
      updatedAt: new Date(now - index * 1000).toISOString(),
      messages: list,
      activities: [],
      approvals: [],
    })
  }
  return { threads, messages, chars }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!
const ms = (value: number) => `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const gc = () => (globalThis as { Bun?: { gc: (full: boolean) => void } }).Bun?.gc(true)

const { AgentService } = await import('../src/server/service')
const { ThreadStore } = await import('../src/server/store')
const { handleApi } = await import('../src/server/api')
const { getService } = await import('../src/server/service')

for (const scale of scales) {
  const directory = await mkdtemp(join(tmpdir(), 't3-mini-search-bench-'))
  const data = build(scale)
  await writeFile(join(directory, 'threads.json'), JSON.stringify(data.threads))
  const store = new ThreadStore(join(directory, 'threads.json'))
  await store.load()
  const service = new AgentService(store)
  // A change between searches: what a reply streaming in does to the narrowing.
  const touch = () => ((service as unknown as { version: number }).version += 1)
  const time = (run: () => unknown, times = 15, between?: () => void) => {
    const samples: number[] = []
    for (let i = 0; i < times; i++) {
      between?.()
      const start = performance.now()
      run()
      samples.push(performance.now() - start)
    }
    return median(samples)
  }
  const count = (query: string) => service.searchMessages(query, 500).length
  console.log(
    `\nScale ${scale}: ${data.threads.length} threads, ${data.messages.toLocaleString()} messages, ` +
      `${(data.chars / 1e6).toFixed(1)} M characters`,
  )
  const rows: [string, string, string][] = []
  for (const [label, query] of [
    ['Rare word', 'zephyrine'],
    ['Common word', 'deploy'],
    ['No match', 'xylophonic'],
  ] as const)
    rows.push([
      label,
      ms(time(() => service.searchMessages(query, 500), 15, touch)),
      `${count(query)} threads`,
    ])
  // Typing "zephyrine" a letter at a time from 2 letters, as the sidebar sends it.
  const typed = 'zephyrine'
  const typing = time(
    () => {
      for (let length = 2; length <= typed.length; length++)
        service.searchMessages(typed.slice(0, length), 500)
    },
    15,
    touch,
  )
  rows.push([
    `Typing "${typed}" (${typed.length - 1} searches)`,
    ms(typing),
    `${ms(typing / (typed.length - 1))} each`,
  ])
  rows.push([
    'Same search, nothing changed',
    ms(time(() => service.searchMessages('zephyrine', 500))),
    'narrowed to earlier matches',
  ])
  // The old way: lowercase every message, then includes.
  const old = (query: string) => {
    const lower = query.toLowerCase()
    let found = 0
    for (const thread of store.threads.values())
      if (thread.messages.some((message) => message.text.toLowerCase().includes(lower))) found++
    return found
  }
  rows.push([
    'Old way, no match (lowercase + includes)',
    ms(time(() => old('xylophonic'))),
    'for comparison',
  ])
  for (const [label, value, note] of rows)
    console.log(`  ${label.padEnd(42)} ${value.padStart(10)}   ${note}`)

  // Memory a burst of searches leaves behind.
  gc()
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < 200; i++) {
    touch()
    service.searchMessages(i % 2 ? 'deploy' : 'xylophonic', 500)
  }
  gc()
  const after = process.memoryUsage().heapUsed
  console.log(
    `  ${'Memory left after 200 searches'.padEnd(42)} ${mb(after - before).padStart(10)}   (no index is kept)`,
  )
  await service.close()
  await rm(directory, { recursive: true, force: true })
}

// The whole route, as a tab calls it: /api/search, results and excerpts as JSON.
{
  const directory = await mkdtemp(join(tmpdir(), 't3-mini-search-bench-'))
  process.env.T3_MINI_DATA_DIR = directory
  const data = build(scales[0]!)
  await writeFile(join(directory, 'threads.json'), JSON.stringify(data.threads))
  await writeFile(join(directory, 'projects.json'), JSON.stringify([]))
  const service = await getService()
  const call = async (query: string) => {
    const response = await handleApi(
      new Request(`http://localhost:4016/api/search?limit=500&q=${encodeURIComponent(query)}`, {
        headers: { origin: 'http://localhost:4016', host: 'localhost:4016' },
      }),
    )
    return (await response.text()).length
  }
  const samples: number[] = []
  let bytes = 0
  for (let i = 0; i < 15; i++) {
    ;(service as unknown as { version: number }).version += 1
    const start = performance.now()
    bytes = await call('deploy')
    samples.push(performance.now() - start)
  }
  console.log(
    `\nThe route at scale ${scales[0]} (/api/search, common word, up to 500 results): ` +
      `${ms(median(samples))}, ${(bytes / 1024).toFixed(0)} KB of JSON`,
  )
  await service.close()
  await rm(directory, { recursive: true, force: true })
}
