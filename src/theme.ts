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

// Runs inline in <head> before first paint, so a saved Light/Dark choice never flashes.
// Static string: it reads only this app's own storage key and writes a whitelisted value.
export const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(key)});if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`
