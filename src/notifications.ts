import { isActive, type Status, type ThreadSummary } from './types'
import { isSoundName, type SoundName } from './sound'

export type ThreadEvent = {
  key: string
  thread: ThreadSummary
  kind: 'completed' | 'failed' | 'interrupted' | 'waiting'
}
export type NotificationPreferences = {
  // Desktop notifications are on only when the user enabled them here and the browser granted permission.
  desktop: boolean
  inApp: boolean
  // Chime when a thread finishes.
  sound: boolean
  soundName: SoundName
  // Set once the first-visit prompt was answered, so it never nags again.
  prompted: boolean
}

const key = 't3-mini:notifications'
const defaults: NotificationPreferences = {
  desktop: false,
  inApp: true,
  sound: true,
  soundName: 'chime',
  prompted: false,
}

export const eventText: Record<ThreadEvent['kind'], string> = {
  completed: 'Finished',
  failed: 'Failed',
  interrupted: 'Stopped',
  waiting: 'Needs your approval',
}
// What happened, for toasts and notifications: a wait on the agent's question reads
// "Has a question" rather than "Needs your approval".
export const eventLabel = (event: ThreadEvent) =>
  event.kind === 'waiting' && event.thread.waitingFor === 'question'
    ? 'Has a question'
    : eventText[event.kind]

// Compares two snapshots of the thread list and reports threads that just finished a turn or
// started waiting for approval. Threads seen for the first time are never reported, so loading
// the app or reconnecting does not replay old results.
export function threadEvents(
  previous: ReadonlyMap<string, Status>,
  threads: ThreadSummary[],
): ThreadEvent[] {
  const events: ThreadEvent[] = []
  for (const thread of threads) {
    const before = previous.get(thread.id)
    if (!before || before === thread.status) continue
    const kind =
      thread.status === 'waiting'
        ? 'waiting'
        : isActive(before) &&
            (thread.status === 'completed' ||
              thread.status === 'failed' ||
              thread.status === 'interrupted')
          ? thread.status
          : null
    if (kind) events.push({ key: `${thread.id}:${thread.updatedAt}:${kind}`, thread, kind })
  }
  return events
}

export function loadNotificationPreferences(): NotificationPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>
    return {
      desktop: saved.desktop === true,
      inApp: saved.inApp !== false,
      sound: saved.sound !== false,
      soundName: isSoundName(saved.soundName) ? saved.soundName : 'chime',
      prompted: saved.prompted === true,
    }
  } catch {
    return { ...defaults }
  }
}
export function saveNotificationPreferences(preferences: NotificationPreferences) {
  try {
    localStorage.setItem(key, JSON.stringify(preferences))
  } catch {
    // Storage can be unavailable (private windows, blocked site data); defaults still work.
  }
}

export type DesktopPermission = NotificationPermission | 'unsupported'
export const desktopPermission = (): DesktopPermission =>
  typeof window !== 'undefined' && 'Notification' in window
    ? Notification.permission
    : 'unsupported'
// Must run from a click: browsers ignore or quietly block permission prompts without one.
export async function requestDesktopPermission(): Promise<DesktopPermission> {
  if (desktopPermission() === 'unsupported') return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return desktopPermission()
  }
}

// Threads that finished while you weren't looking, so the sidebar can mark them until opened.
// Unread markers used to be kept here per browser; they're on the server now (Thread.unread).
// Clear the old copy once.
try {
  if (typeof localStorage !== 'undefined') localStorage.removeItem('t3-mini:unread')
} catch {
  // Nothing to clear.
}

// Open t3 mini tabs in this browser, so only one of them notifies: the one you used last.
// If you're on a t3 mini tab, that tab is the last one used and it's focused, so nothing pops
// up; when you're elsewhere, that one tab sends the notification (and plays the sound).
// Kept in localStorage (shared by every tab) rather than a BroadcastChannel round trip, so the
// check is synchronous when an event arrives.
type TabRecord = { visitedAt: number; aliveAt: number }
const tabsKey = 't3-mini:tabs'
// A tab that stopped checking in (crashed, killed) no longer counts. Background tabs' timers
// can be throttled to once a minute, so allow a few missed check-ins.
export const tabStaleMs = 3 * 60_000
export const tabHeartbeatMs = 30_000
// Not crypto.randomUUID: phones reach t3 mini over plain HTTP, where it isn't available.
const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

// The tab that should notify: the most recently visited one that is still open.
export function notifyingTab(tabs: Record<string, TabRecord>, now: number): string | undefined {
  let best: string | undefined
  let bestAt = -1
  for (const [id, tab] of Object.entries(tabs))
    if (now - tab.aliveAt < tabStaleMs && tab.visitedAt > bestAt) {
      best = id
      bestAt = tab.visitedAt
    }
  return best
}
function loadTabs(): Record<string, TabRecord> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(tabsKey) || '{}')
    const tabs: Record<string, TabRecord> = {}
    if (saved && typeof saved === 'object')
      for (const [id, tab] of Object.entries(saved as Record<string, Partial<TabRecord>>))
        if (typeof tab?.visitedAt === 'number' && typeof tab.aliveAt === 'number')
          tabs[id] = { visitedAt: tab.visitedAt, aliveAt: tab.aliveAt }
    return tabs
  } catch {
    return {}
  }
}
function updateTabs(change: (tabs: Record<string, TabRecord>, now: number) => void) {
  const now = Date.now()
  const tabs = loadTabs()
  change(tabs, now)
  // Drop tabs that went away without saying so.
  for (const [id, tab] of Object.entries(tabs)) if (now - tab.aliveAt >= tabStaleMs) delete tabs[id]
  try {
    localStorage.setItem(tabsKey, JSON.stringify(tabs))
  } catch {
    // Without storage every tab notifies on its own, as before.
  }
}
// The same reports go to the t3 mini server, which sees the tabs of every browser profile
// (each profile has its own localStorage) and phone, and picks one tab for all of them. Its
// choice arrives with live updates (setServerTab); localStorage is the fallback while the
// server's choice isn't known.
let serverTab: string | null | undefined
// The thread this tab shows and whether you're looking at it, sent with every report, so the
// server doesn't mark a thread you're watching unread when it finishes.
let view: { viewing?: string; watching?: boolean } = {}
export function setTabView(next: { viewing?: string; watching: boolean }) {
  if (next.viewing === view.viewing && next.watching === view.watching) return
  view = next
  report('alive')
}
export const setServerTab = (id: string | null | undefined) => {
  serverTab = id
}
function report(event: 'visit' | 'alive' | 'leave') {
  if (typeof fetch === 'undefined') return
  void fetch('/api/tabs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tabId, event, ...view }),
    // Still sent while the page is closing.
    keepalive: true,
  })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((data?: { activeTab?: string | null }) => {
      if (data && 'activeTab' in data) serverTab = data.activeTab
    })
    .catch(() => {})
}
// This tab is being used (focused or shown).
export const markTabVisited = () => {
  updateTabs((tabs, now) => {
    tabs[tabId] = { visitedAt: now, aliveAt: now }
  })
  report('visit')
}
// This tab is still open (also registers a tab opened in the background).
export const markTabAlive = () => {
  updateTabs((tabs, now) => {
    tabs[tabId] = { visitedAt: tabs[tabId]?.visitedAt ?? 0, aliveAt: now }
  })
  report('alive')
}
// This tab is closing.
export const forgetTab = () => {
  updateTabs((tabs) => {
    delete tabs[tabId]
  })
  report('leave')
}
// Whether this tab is the one that notifies (and plays music): the server's choice across
// every browser, else this browser's own record; with neither (storage blocked), yes.
export function isNotifyingTab() {
  if (serverTab) return serverTab === tabId
  const tab = notifyingTab(loadTabs(), Date.now())
  return tab === undefined || tab === tabId
}
