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
