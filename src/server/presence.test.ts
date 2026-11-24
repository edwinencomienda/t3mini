import { expect, it } from 'vitest'
import { activeSeconds, atMac, parseIdle, parseLocked } from './presence'

it('reads how long the keyboard and mouse have been idle, and whether the screen is locked', () => {
  // What `ioreg -c IOHIDSystem -k HIDIdleTime` prints (nanoseconds).
  expect(parseIdle('    | |     "HIDIdleTime" = 24431551083\n')).toBeCloseTo(24.43, 1)
  expect(parseIdle('nothing here')).toBeNull()
  expect(parseLocked('      "IOConsoleLocked" = Yes\n')).toBe(true)
  expect(parseLocked('      "IOConsoleLocked" = No\n')).toBe(false)
})

it('counts you at the Mac only when it was used lately and isn’t locked', async () => {
  const at = (idleSeconds: number, locked = false) => atMac(async () => ({ idleSeconds, locked }))
  expect(await at(5)).toBe(true)
  expect(await at(activeSeconds + 1)).toBe(false)
  expect(await at(5, true)).toBe(false)
  // Unknown (not a Mac, ioreg failed): away, so phones still get their push.
  expect(await atMac(async () => null)).toBe(false)
})
