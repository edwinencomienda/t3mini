import { registerShared, shareSetting } from './shared-settings'
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
// Applies a theme and keeps this browser's copy (read before first paint by themeScript).
function adoptTheme(theme: Theme) {
  applyTheme(theme)
  try {
    if (theme === 'system') localStorage.removeItem(key)
    else localStorage.setItem(key, theme)
  } catch {
    // Storage can be unavailable; the choice still applies for this page.
  }
}
// Your choice, shared with every browser and window (see shared-settings.ts).
export function saveTheme(theme: Theme) {
  adoptTheme(theme)
  shareSetting({ theme })
}
// The theme changed from another browser or window.
const themeListeners = new Set<(theme: Theme) => void>()
export function onThemeChange(listener: (theme: Theme) => void) {
  themeListeners.add(listener)
  return () => void themeListeners.delete(listener)
}
registerShared(
  'theme',
  () => (typeof localStorage === 'undefined' || loadTheme() === 'system' ? undefined : loadTheme()),
  (theme) => {
    if (theme === loadTheme()) return
    adoptTheme(theme)
    themeListeners.forEach((listener) => listener(theme))
  },
)
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

// The sidebar's width in pixels after you drag its edge (wide screens), as a CSS variable on
// <html>; none means the default width.
const sidebarWidthKey = 't3-mini:sidebar-width'
export const sidebarWidthLimits = { min: 208, max: 480 }
export function saveSidebarWidth(width: number | null) {
  if (width === null) document.documentElement.style.removeProperty('--sidebar-width')
  else document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
  try {
    if (width === null) localStorage.removeItem(sidebarWidthKey)
    else localStorage.setItem(sidebarWidthKey, String(width))
  } catch {
    // Storage can be unavailable; the width still applies for this page.
  }
}

// Runs inline in <head> before first paint, so a saved theme, hidden sidebar, or sidebar width
// never flashes. Static string: it reads only this app's own storage keys and writes
// whitelisted values (the width only as a number within the limits).
export const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(key)});if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;if(localStorage.getItem(${JSON.stringify(sidebarKey)})==='1')document.documentElement.dataset.sidebar='hidden';var w=Math.round(Number(localStorage.getItem(${JSON.stringify(sidebarWidthKey)})));if(w>=${sidebarWidthLimits.min}&&w<=${sidebarWidthLimits.max})document.documentElement.style.setProperty('--sidebar-width',w+'px')}catch(e){}`
