import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BrowserStats, browserUse } from './browser-stats'
import type { Activity } from '../types'

const step = (label: string, summary: string, browser = false): Activity => ({
  id: crypto.randomUUID(),
  label,
  summary,
  status: 'completed',
  ...(browser ? { browser: true } : {}),
})

it('tells turns that changed UI files apart, and whether they used the browser', () => {
  expect(browserUse([step('Edit', 'src/components/Button.tsx')])).toEqual({
    uiChanged: true,
    checked: false,
  })
  expect(
    browserUse([step('Write', 'resources/views/home.blade.php'), step('Check page', '', true)]),
  ).toEqual({ uiChanged: true, checked: true })
  // Server code, reading a UI file, or running a command don't count as UI changes.
  expect(browserUse([step('Edit', 'src/server/api.ts')]).uiChanged).toBe(false)
  expect(browserUse([step('Read', 'src/styles.css')]).uiChanged).toBe(false)
  expect(browserUse([step('Run', 'vite build --outDir dist/index.html')]).uiChanged).toBe(false)
  // Codex lists several files in one step.
  expect(browserUse([step('Edit', 'src/api.ts, src/App.vue +2 more')]).uiChanged).toBe(true)
})

it('counts per agent, keeps the counts across restarts, and resets', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 't3-mini-stats-')), 'browser-stats.json')
  const stats = new BrowserStats(path)
  stats.record('claude', [step('Edit', 'src/App.tsx'), step('Open page', '', true)])
  stats.record('claude', [step('Edit', 'src/styles.css')])
  stats.record('claude', [step('Edit', 'src/server.ts')])
  stats.record('codex', [step('Edit', 'app.vue')])
  expect(stats.data).toMatchObject({
    claude: { uiTurns: 2, checked: 1 },
    codex: { uiTurns: 1, checked: 0 },
  })
  // Saved in the background; a new instance (a restart) reads it back.
  const final = JSON.stringify(stats.data)
  for (let i = 0; i < 50 && (await readFile(path, 'utf8').catch(() => '')) !== final; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  const restarted = new BrowserStats(path)
  await restarted.load()
  expect(restarted.data).toEqual(stats.data)
  expect(restarted.reset()).toMatchObject({
    claude: { uiTurns: 0, checked: 0 },
    codex: { uiTurns: 0, checked: 0 },
  })
})
