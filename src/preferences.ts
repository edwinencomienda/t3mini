import { defaultPermission, isPermissionMode, type AgentSettings } from './agent-settings'
import type { Provider } from './types'
import { registerShared, shareSetting } from './shared-settings'

// The last choices made in this browser, so new threads start where the user left off.
// Stored per provider because model and effort ids are provider-specific.
export type Preferences = {
  provider?: Provider
  cwd?: string
  settings: Partial<Record<Provider, AgentSettings>>
}

const key = 't3-mini:preferences'
const isProvider = (value: unknown): value is Provider => value === 'codex' || value === 'claude'
const text = (value: unknown) => (typeof value === 'string' ? value : '')

export function loadPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>
    const settings: Preferences['settings'] = {}
    const savedSettings = (saved.settings || {}) as Record<string, Record<string, unknown>>
    for (const provider of ['codex', 'claude'] as const) {
      const value = savedSettings[provider]
      if (!value) continue
      settings[provider] = {
        model: text(value.model),
        effort: value.model ? text(value.effort) : '',
        serviceTier: value.model ? text(value.serviceTier) : '',
        permissionMode: isPermissionMode(value.permissionMode)
          ? value.permissionMode
          : defaultPermission,
      }
    }
    return {
      provider: isProvider(saved.provider) ? saved.provider : undefined,
      cwd: text(saved.cwd) || undefined,
      settings,
    }
  } catch {
    return { settings: {} }
  }
}

export function settingsFor(provider: Provider, preferences = loadPreferences()): AgentSettings {
  return (
    preferences.settings[provider] ?? { model: '', effort: '', permissionMode: defaultPermission }
  )
}

export function rememberChoice(provider: Provider, settings: AgentSettings, cwd?: string) {
  const current = loadPreferences()
  const next: Preferences = {
    ...current,
    provider,
    ...(cwd ? { cwd } : {}),
    settings: { ...current.settings, [provider]: settings },
  }
  store(next)
  // The same defaults in every browser and window (see shared-settings.ts).
  shareSetting({ agent: next })
}
function store(preferences: Preferences) {
  try {
    localStorage.setItem(key, JSON.stringify(preferences))
  } catch {
    // Storage can be unavailable (private windows, blocked site data); defaults still work.
  }
}
registerShared(
  'agent',
  () => {
    if (typeof localStorage === 'undefined') return undefined
    const preferences = loadPreferences()
    return preferences.provider || Object.keys(preferences.settings).length
      ? preferences
      : undefined
  },
  (agent) => store(agent),
)
