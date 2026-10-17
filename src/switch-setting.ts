import { useEffect, useState } from 'react'
import { registerShared, shareSetting } from './shared-settings'

// An on/off appearance setting (on unless turned off), shared by every browser and window
// through the server (`field`), with this browser's copy in localStorage so it applies at once.
// Every component using it follows right away.
export function switchSetting(key: string, field: 'projectIcons' | 'animations') {
  const listeners = new Set<(on: boolean) => void>()
  const stored = () => {
    try {
      return localStorage.getItem(key) !== 'off'
    } catch {
      return true
    }
  }
  // This browser's copy, and everything showing it.
  function adopt(on: boolean) {
    try {
      if (on) localStorage.removeItem(key)
      else localStorage.setItem(key, 'off')
    } catch {
      // Storage can be unavailable; the choice still applies until reload.
    }
    listeners.forEach((listener) => listener(on))
  }
  function save(on: boolean) {
    adopt(on)
    shareSetting({ [field]: on })
  }
  registerShared(
    field,
    // Carried over only when turned off here (on is the default).
    () => (typeof localStorage !== 'undefined' && !stored() ? false : undefined),
    (on) => {
      if (on !== stored()) adopt(on)
    },
  )
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
