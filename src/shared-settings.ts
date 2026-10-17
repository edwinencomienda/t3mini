import type { UiSettings } from './types'

// Settings shared by every browser, profile, and window (theme, project icons, working
// animations, agent defaults, collapsed projects, background music…). The server keeps them
// (.data/ui.json) and sends them with every live update; each browser also keeps its own copy
// so they apply instantly on load (the theme without a flash) and when offline.
//
// A setting registers how to read this browser's copy and how to adopt the server's value.
// When the server has no value yet for a setting, this browser's copy is sent up once, so a
// choice made before settings were shared carries over.

type Field = Exclude<keyof UiSettings, 'groupBy'>
type Entry = { local: () => unknown; adopt: (value: never) => void }
const fields = new Map<Field, Entry>()
let latest: Partial<UiSettings> | undefined

export function registerShared<K extends Field>(
  field: K,
  local: () => UiSettings[K] | undefined,
  adopt: (value: NonNullable<UiSettings[K]>) => void,
) {
  const entry: Entry = { local, adopt: adopt as (value: never) => void }
  fields.set(field, entry)
  // Settings that arrived before this one registered.
  if (latest?.[field] !== undefined) adopt(latest[field] as NonNullable<UiSettings[K]>)
  return () => {
    if (fields.get(field) === entry) fields.delete(field)
  }
}

// What each setting last adopted, so a live update that didn't change it does nothing (live
// updates arrive many times a second while an agent streams).
const adopted = new Map<Field, string>()
// The server's settings (bootstrap or a live update).
export function applyShared(remote: UiSettings) {
  latest = remote
  const missing: Partial<UiSettings> = {}
  for (const [field, entry] of fields) {
    const value = remote[field]
    if (value !== undefined) {
      const serialized = JSON.stringify(value)
      if (adopted.get(field) === serialized) continue
      adopted.set(field, serialized)
      entry.adopt(value as never)
    } else {
      const local = entry.local()
      if (local !== undefined) Object.assign(missing, { [field]: local })
    }
  }
  if (Object.keys(missing).length) shareSetting(missing)
}

// Saves a change for everyone. Quick repeats (a volume slider) are merged into one request.
let pending: Partial<UiSettings> = {}
let timer: ReturnType<typeof setTimeout> | undefined
export function shareSetting(change: Partial<UiSettings>) {
  latest = { ...latest, ...change } as Partial<UiSettings>
  // Our own change coming back with the next live update isn't news.
  for (const [field, value] of Object.entries(change))
    adopted.set(field as Field, JSON.stringify(value))
  pending = { ...pending, ...change }
  clearTimeout(timer)
  timer = setTimeout(() => {
    const body = pending
    pending = {}
    void fetch('/api/ui-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // Offline: this browser's copy still applies; the next change tries again.
    })
  }, 250)
}

// The latest settings from the server, read now (for values that aren't broadcast).
export async function fetchShared(): Promise<Partial<UiSettings> | undefined> {
  try {
    const response = await fetch('/api/ui-settings')
    return response.ok ? ((await response.json()) as Partial<UiSettings>) : undefined
  } catch {
    return undefined
  }
}
