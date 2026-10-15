export type Theme = 'system' | 'light' | 'dark'
export const themes: Theme[] = ['system', 'light', 'dark']
export const themeLabels: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const key = 't3-mini:theme'
const isTheme = (value: unknown): value is Theme => themes.includes(value as Theme)

export function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(key)
    return isTheme(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}
// System removes the attribute so the stylesheet follows prefers-color-scheme.
export function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}
export function saveTheme(theme: Theme) {
  applyTheme(theme)
  try {
    if (theme === 'system') localStorage.removeItem(key)
    else localStorage.setItem(key, theme)
  } catch {
    // Storage can be unavailable; the choice still applies for this page.
  }
}
export const nextTheme = (theme: Theme) => themes[(themes.indexOf(theme) + 1) % themes.length]!

// Whether the sidebar is hidden on wide screens. Kept as an attribute on <html> so CSS can
// lay out the page before React runs.
const sidebarKey = 't3-mini:sidebar-hidden'
export const isSidebarHidden = () =>
  typeof document !== 'undefined' && document.documentElement.dataset.sidebar === 'hidden'
export function saveSidebarHidden(hidden: boolean) {
  if (hidden) document.documentElement.dataset.sidebar = 'hidden'
  else delete document.documentElement.dataset.sidebar
  try {
    if (hidden) localStorage.setItem(sidebarKey, '1')
    else localStorage.removeItem(sidebarKey)
  } catch {
    // Storage can be unavailable; the choice still applies for this page.
  }
}

// Runs inline in <head> before first paint, so a saved theme or hidden sidebar never flashes.
// Static string: it reads only this app's own storage keys and writes whitelisted values.
export const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(key)});if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;if(localStorage.getItem(${JSON.stringify(sidebarKey)})==='1')document.documentElement.dataset.sidebar='hidden'}catch(e){}`
