import { expect, it, vi } from 'vitest'
import { tabStaleMs } from '../notifications'
import { TabRegistry } from './tabs'

it('picks the tab used last across every browser, and hands over when it goes', () => {
  const changed = vi.fn()
  const tabs = new TabRegistry(changed)
  // Two profiles open; you're using profile A.
  tabs.report('profile-a-tab', 'visit', 1000)
  tabs.report('profile-b-tab', 'alive', 1100)
  expect(tabs.leader(1100)).toBe('profile-a-tab')
  // A background heartbeat doesn't take over.
  tabs.report('profile-b-tab', 'alive', 2000)
  expect(tabs.leader(2000)).toBe('profile-a-tab')
  // Switching to profile B does.
  tabs.report('profile-b-tab', 'visit', 3000)
  expect(tabs.leader(3000)).toBe('profile-b-tab')
  // Closing it hands back to A.
  tabs.report('profile-b-tab', 'leave', 4000)
  expect(tabs.leader(4000)).toBe('profile-a-tab')
  // Live updates go out only when the choice changes.
  expect(changed).toHaveBeenCalledTimes(3)
})

it('forgets tabs that stopped checking in', () => {
  const tabs = new TabRegistry()
  tabs.report('crashed', 'visit', 0)
  tabs.report('still-open', 'alive', tabStaleMs - 1000)
  expect(tabs.leader(tabStaleMs + 1)).toBe('still-open')
  tabs.report('still-open', 'leave', tabStaleMs + 2)
  expect(tabs.leader(tabStaleMs + 2)).toBeUndefined()
})

it('knows which browsers’ push subscriptions you’re using t3 mini in right now', () => {
  const tabs = new TabRegistry()
  const mac = 'https://web.push.apple.com/mac'
  // Focused on a thread in a browser that gets push: that browser is in use.
  tabs.report('mac-tab', 'visit', 1000, { viewing: 't1', watching: true, push: mac })
  expect([...tabs.pushInUse(1000)]).toEqual([mac])
  // In the background (not watching): push goes to it again.
  tabs.report('mac-tab', 'alive', 2000, { viewing: 't1', watching: false, push: mac })
  expect(tabs.pushInUse(2000).size).toBe(0)
  // Focused again, then gone quiet past the stale time: not in use.
  tabs.report('mac-tab', 'alive', 3000, { viewing: 't1', watching: true, push: mac })
  expect(tabs.pushInUse(3000 + tabStaleMs).size).toBe(0)
})

it('knows when a desktop notification will show on this Mac', () => {
  const tabs = new TabRegistry()
  // A Mac tab with desktop notifications on, used last.
  tabs.report('mac', 'visit', 1000, { local: true, notifies: true })
  expect(tabs.deskNotifies(1000)).toBe(true)
  // You switch to t3 mini on your phone: that tab notifies now, not the Mac.
  tabs.report('phone', 'visit', 2000, { local: false, notifies: true })
  expect(tabs.deskNotifies(2000)).toBe(false)
  // Back on the Mac, but desktop notifications are off there.
  tabs.report('mac', 'visit', 3000, { local: true, notifies: false })
  expect(tabs.deskNotifies(3000)).toBe(false)
  // A heartbeat without the flags keeps what the tab said before.
  tabs.report('mac', 'visit', 4000, { local: true, notifies: true })
  tabs.report('mac', 'alive', 5000, { local: true })
  expect(tabs.deskNotifies(5000)).toBe(true)
})
