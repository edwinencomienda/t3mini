import { useEffect, useState } from 'react'
import { registerShared, shareSetting } from './shared-settings'

// Settings → Agents → Open public websites: whether the agents' browser may open public sites
// too (read-only there; see server/browser.ts). Off unless turned on, shared by every window
// through the server (no local copy: the server is what enforces it).
let current = false
const listeners = new Set<(on: boolean) => void>()
registerShared(
  'browserPublic',
  () => undefined,
  (on) => {
    current = on === true
    listeners.forEach((listener) => listener(current))
  },
)
export function saveBrowserPublic(on: boolean) {
  current = on
  listeners.forEach((listener) => listener(on))
  shareSetting({ browserPublic: on })
}
export function useBrowserPublic() {
  const [on, setOn] = useState(current)
  useEffect(() => {
    setOn(current)
    listeners.add(setOn)
    return () => void listeners.delete(setOn)
  }, [])
  return on
}
