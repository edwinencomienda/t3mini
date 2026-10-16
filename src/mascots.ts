import { useEffect, useState } from 'react'
import type { Provider } from './types'

// Animated Claude and Codex characters for the working line (public/mascots), picked by what
// the agent is doing. A per-browser setting (Settings → Appearance) turns them off in favor of
// the plain dots; so does the system's Reduce motion setting.

// thinking and working loop; celebrating plays once (4 s) and stops, so each finish loads it
// fresh (`fresh` makes it a new image, restarting the animation).
export type Mood = 'thinking' | 'working' | 'celebrating'
export const mascotSrc = (provider: Provider, mood: Mood, fresh?: string) =>
  `/mascots/${provider}-${mood}.gif${fresh ? `?t=${encodeURIComponent(fresh)}` : ''}`

// The GIFs leave room above the character (thought bubbles, confetti), so each sits below the
// image's middle. How far to lift each one, in pixels at the 40px size shown, so the
// character lines up with the text (measured from the drawn pixels).
const lift: Record<string, number> = {
  'claude-working': 7,
  'claude-thinking': 6,
  'claude-celebrating': 4,
  'codex-working': 4,
  'codex-thinking': 2,
  'codex-celebrating': 1,
}
export const mascotLift = (provider: Provider, mood: Mood) => lift[`${provider}-${mood}`] ?? 0

const key = 't3-mini:mascots'
const listeners = new Set<(on: boolean) => void>()

function stored() {
  try {
    return localStorage.getItem(key) !== 'off'
  } catch {
    return true
  }
}
export function saveMascots(on: boolean) {
  try {
    if (on) localStorage.removeItem(key)
    else localStorage.setItem(key, 'off')
  } catch {
    // Storage can be unavailable; the choice still applies until reload.
  }
  listeners.forEach((listener) => listener(on))
}
// The saved choice (on unless turned off), for the Settings switch.
export function useMascotSetting() {
  // Off during the server render and first paint; the saved choice is read after mount.
  const [on, setOn] = useState(false)
  useEffect(() => {
    setOn(stored())
    listeners.add(setOn)
    return () => void listeners.delete(setOn)
  }, [])
  return on
}
// Whether to show the characters now: the setting, unless Reduce motion is on.
export function useMascots() {
  const on = useMascotSetting()
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const change = () => setReduced(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return on && !reduced
}
