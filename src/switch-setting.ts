import { useEffect, useState } from 'react'

// An on/off appearance setting kept per browser (on unless turned off), shared live by every
// component using it: the Settings switch flips it and the UI follows right away.
export function switchSetting(key: string) {
  const listeners = new Set<(on: boolean) => void>()
  const stored = () => {
    try {
      return localStorage.getItem(key) !== 'off'
    } catch {
      return true
    }
  }
  function save(on: boolean) {
    try {
      if (on) localStorage.removeItem(key)
      else localStorage.setItem(key, 'off')
    } catch {
      // Storage can be unavailable; the choice still applies until reload.
    }
    listeners.forEach((listener) => listener(on))
  }
  // Off during the server render and first paint unless `initial` says otherwise; the saved
  // choice is read after mount.
  function useSetting(initial = false) {
    const [on, setOn] = useState(initial)
    useEffect(() => {
      setOn(stored())
      listeners.add(setOn)
      return () => void listeners.delete(setOn)
    }, [])
    return on
  }
  return { save, useSetting }
}
