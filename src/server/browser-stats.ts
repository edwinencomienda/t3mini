import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Activity, Provider } from '../types'

// How often agents check their work in the browser: of the finished turns that changed UI files
// (components, pages, styles…), how many also used a browser tool. Counted per agent, to see
// whether nudges like the tool instructions make a difference. Only counts are kept: no paths,
// no thread ids. Saved in .data/browser-stats.json.

export type BrowserCounts = { uiTurns: number; checked: number }
export type BrowserStatsData = { since: string; claude: BrowserCounts; codex: BrowserCounts }

// Files people see: components, templates, and styles.
const uiFile =
  /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|blade\.php|erb|hbs|twig|liquid|mdx)\b/i

// Whether a turn's steps changed a UI file, and whether they used the browser.
export function browserUse(activities: Activity[]) {
  const uiChanged = activities.some(
    (activity) =>
      (activity.label === 'Edit' || activity.label === 'Write') &&
      uiFile.test(activity.summary ?? ''),
  )
  return { uiChanged, checked: activities.some((activity) => activity.browser) }
}

const empty = (): BrowserStatsData => ({
  since: new Date().toISOString(),
  claude: { uiTurns: 0, checked: 0 },
  codex: { uiTurns: 0, checked: 0 },
})
const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
const counts = (value: unknown): BrowserCounts => {
  const item = (value ?? {}) as Partial<BrowserCounts>
  return { uiTurns: count(item.uiTurns), checked: count(item.checked) }
}

export class BrowserStats {
  data = empty()
  private queue: Promise<void> = Promise.resolve()
  constructor(readonly path: string) {}
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8')) as Partial<BrowserStatsData>
      this.data = {
        since: typeof saved.since === 'string' ? saved.since : this.data.since,
        claude: counts(saved.claude),
        codex: counts(saved.codex),
      }
    } catch {
      // Missing or unreadable: start counting now.
    }
  }
  // A finished turn. Only turns that changed UI files count.
  record(provider: Provider, activities: Activity[]) {
    const { uiChanged, checked } = browserUse(activities)
    if (!uiChanged) return
    this.data[provider].uiTurns++
    if (checked) this.data[provider].checked++
    this.save()
  }
  // Starts counting again (Settings → Agents → Reset).
  reset() {
    this.data = empty()
    this.save()
    return this.data
  }
  // Best effort: a failed save only loses a count.
  private save() {
    const contents = JSON.stringify(this.data)
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(this.path + '.tmp', contents, { mode: 0o600 })
        await rename(this.path + '.tmp', this.path)
      })
      .catch(() => {})
  }
}
