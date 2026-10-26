import type { Thread } from './types'

// Live updates for the open thread (/api/events): instead of the whole thread (hundreds of KB
// in a long one) ten times a second while a reply streams, each tab gets the full thread once
// and then only what changed: the thread's own fields when any of them changed, and the messages
// and steps that differ, by position. Shared by the server (ThreadDiff) and the browser
// (applyThreadPatch).

// A list's new length and the items that differ from the previous list, by index. Items past the
// old end are always included, so the list can be rebuilt from the previous one.
export type ListPatch<T> = { count: number; changed: [number, T][] }
type Rest = Omit<Thread, 'messages' | 'activities'>
export type ThreadPatch = {
  id: string
  // Every field but the lists, whole, when any of them changed.
  rest?: Rest
  messages?: ListPatch<Thread['messages'][number]>
  activities?: ListPatch<Thread['activities'][number]>
}

// What one tab was last sent, for the next diff.
export class ThreadDiff {
  private started = false
  private id: string | undefined
  private rest = ''
  private lists: Record<'messages' | 'activities', string[]> = { messages: [], activities: [] }
  // stringify: how messages and steps are serialized; the server shares one cache between tabs
  // within an update, so each message is serialized once, not once per tab.
  constructor(private stringify: (value: object) => string = JSON.stringify) {}

  // What to send this time: the whole thread (first time, or another thread), a patch, or
  // nothing when nothing changed.
  next(
    thread: Thread | null,
  ): { thread: Thread | null } | { threadPatch: ThreadPatch } | undefined {
    if (!thread) {
      const send = !this.started || this.id !== undefined
      this.started = true
      this.id = undefined
      return send ? { thread: null } : undefined
    }
    const { messages, activities, ...rest } = thread
    const restJson = JSON.stringify(rest)
    if (!this.started || this.id !== thread.id) {
      this.started = true
      this.id = thread.id
      this.rest = restJson
      this.lists.messages = messages.map((item) => this.stringify(item))
      this.lists.activities = activities.map((item) => this.stringify(item))
      return { thread }
    }
    const patch: ThreadPatch = { id: thread.id }
    if (restJson !== this.rest) {
      this.rest = restJson
      patch.rest = rest
    }
    const messagesPatch = this.diff('messages', messages)
    if (messagesPatch) patch.messages = messagesPatch
    const activitiesPatch = this.diff('activities', activities)
    if (activitiesPatch) patch.activities = activitiesPatch
    return patch.rest || patch.messages || patch.activities ? { threadPatch: patch } : undefined
  }

  private diff<T>(key: 'messages' | 'activities', items: T[]): ListPatch<T> | undefined {
    const previous = this.lists[key]
    const json = items.map((item) => this.stringify(item as object))
    const changed: [number, T][] = []
    for (let index = 0; index < items.length; index++)
      if (json[index] !== previous[index]) changed.push([index, items[index]!])
    this.lists[key] = json
    return changed.length || items.length !== previous.length
      ? { count: items.length, changed }
      : undefined
  }
}

const applyList = <T>(previous: T[], patch: ListPatch<T> | undefined) => {
  if (!patch) return previous
  const next = previous.slice(0, patch.count)
  for (const [index, item] of patch.changed) next[index] = item
  return next
}

// The thread after a patch. Unchanged messages and steps stay the same objects.
export function applyThreadPatch(base: Thread, patch: ThreadPatch): Thread {
  const { messages, activities, ...rest } = base
  return {
    ...(patch.rest ?? rest),
    messages: applyList(messages, patch.messages),
    activities: applyList(activities, patch.activities),
  } as Thread
}
