import type { Thread } from './types'

// Live updates arrive as fresh JSON, so every message, step, and sidebar thread is a new object
// even when nothing about it changed, and memoized views (MessageView, StepRow, ThreadRow) would
// re-render them all. These helpers keep the previous object for anything whose content is the
// same, so only what really changed (the reply being written, the thread that moved) renders.

// Each kept object's JSON, so it's only serialized once however many updates it survives.
const serialized = new WeakMap<object, string>()
const json = (value: object) => {
  let text = serialized.get(value)
  if (text === undefined) {
    text = JSON.stringify(value)
    serialized.set(value, text)
  }
  return text
}

// The next list, with each item that's unchanged since the previous list (same key, same
// content) replaced by the previous object. Returns the previous list itself when nothing
// changed at all, so even the array keeps its identity. Items are keyed by id, or by key().
export function reuseItems<T extends object>(
  previous: T[] | undefined,
  next: T[],
  key: (item: T) => string = (item) => (item as { id: string }).id,
): T[] {
  if (!previous?.length) return next
  const byKey = new Map(previous.map((item) => [key(item), item]))
  let same = previous.length === next.length
  const merged = next.map((item, index) => {
    const old = byKey.get(key(item))
    // The same object (a patched thread keeps its unchanged messages) needs no comparing.
    const kept = old && (old === item || json(old) === JSON.stringify(item)) ? old : item
    if (kept !== previous[index]) same = false
    return kept
  })
  return same ? previous : merged
}

// The next snapshot of a thread, keeping the previous message and step objects that didn't
// change (only when it's the same thread).
export function reuseThread(previous: Thread | null | undefined, next: Thread): Thread {
  if (!previous || previous.id !== next.id) return next
  return {
    ...next,
    messages: reuseItems(previous.messages, next.messages),
    activities: reuseItems(previous.activities, next.activities),
  }
}
