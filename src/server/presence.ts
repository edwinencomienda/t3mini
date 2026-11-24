import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Whether you're at this Mac right now, for push notifications (push.ts → AwayPush): phones
// only get a push when you're away, like Slack. macOS knows how long ago the keyboard or mouse
// was last used (IOHIDSystem's HIDIdleTime, in nanoseconds) and whether the screen is locked
// (IOConsoleLocked); `ioreg` reads both without any permission prompt, in a few milliseconds.
// Anywhere else (a Linux machine), presence is unknown and pushes go out as before.

const exec = promisify(execFile)
const ioreg = '/usr/sbin/ioreg'

export type Presence = { idleSeconds: number; locked: boolean }

// HIDIdleTime from `ioreg -c IOHIDSystem`: the first one (there's one per HID system).
export function parseIdle(output: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output)
  return match ? Number(match[1]) / 1e9 : null
}
export const parseLocked = (output: string) => /"IOConsoleLocked"\s*=\s*Yes/.test(output)

// Fixed arguments, no shell. Remembered for a couple of seconds: a burst of finished threads
// asks once.
let cached: { at: number; value: Promise<Presence | null> } | undefined
export function macPresence(now = Date.now()): Promise<Presence | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  if (cached && now - cached.at < 2000) return cached.value
  const value = (async () => {
    try {
      const [idle, root] = await Promise.all([
        exec(ioreg, ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'], { timeout: 2000 }),
        exec(ioreg, ['-n', 'Root', '-d', '1', '-k', 'IOConsoleLocked'], { timeout: 2000 }),
      ])
      const idleSeconds = parseIdle(idle.stdout)
      if (idleSeconds === null) return null
      return { idleSeconds, locked: parseLocked(root.stdout) }
    } catch {
      return null
    }
  })()
  cached = { at: now, value }
  return value
}

// At the Mac: the keyboard or mouse was used within `activeSeconds` and the screen isn't
// locked. Unknown (not a Mac, ioreg failed) counts as away, so phones still get their push.
export const activeSeconds = 120
export async function atMac(presence: () => Promise<Presence | null> = () => macPresence()) {
  const now = await presence()
  return Boolean(now && !now.locked && now.idleSeconds < activeSeconds)
}
