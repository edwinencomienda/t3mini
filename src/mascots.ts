import { useEffect, useState } from 'react'
import type { Provider } from './types'
import { switchSetting } from './switch-setting'

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

const setting = switchSetting('t3-mini:mascots')
export const saveMascots = setting.save
// The saved choice (on unless turned off), for the Settings switch.
export const useMascotSetting = () => setting.useSetting()
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
