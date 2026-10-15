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
const unreadKey = 't3-mini:unread'
export function loadUnread(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(unreadKey) || '[]')
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}
export function saveUnread(ids: Set<string>) {
  try {
    localStorage.setItem(unreadKey, JSON.stringify([...ids]))
  } catch {
    // Without storage the indicator still works until reload.
  }
}
