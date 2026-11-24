import { useEffect, useState } from 'react'
import { registerShared, shareSetting } from './shared-settings'

// Settings → Notifications → Phone notifications: phones (paired devices and the iPhone app)
// get push notifications only while you're away from the Mac (like Slack; the default), or
// always. Shared by every window through the server, which is what decides (server/push.ts →
// AwayPush), so there's no local copy.
export type PhonePush = 'away' | 'always'
let current: PhonePush = 'away'
const listeners = new Set<(value: PhonePush) => void>()
registerShared(
  'phonePush',
  () => undefined,
  (value) => {
    current = value === 'always' ? 'always' : 'away'
    listeners.forEach((listener) => listener(current))
  },
)
export function savePhonePush(value: PhonePush) {
  current = value
  listeners.forEach((listener) => listener(value))
  shareSetting({ phonePush: value })
}
export function usePhonePush() {
  const [value, setValue] = useState(current)
  useEffect(() => {
    setValue(current)
    listeners.add(setValue)
    return () => void listeners.delete(setValue)
  }, [])
  return value
}
