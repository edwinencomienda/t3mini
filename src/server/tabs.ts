import { notifyingTab, tabStaleMs } from '../notifications'

// The open t3 mini tabs in every browser, profile, and phone, so exactly one of them sends
// desktop notifications, plays the finish sound, and plays the background music: the one you
// used last. (Each browser profile has its own storage, so tabs can't agree on that by
// themselves.) Tabs report being used (focus), still being open (a heartbeat), and closing;
// the choice goes out with live updates whenever it changes.

type Record = {
  visitedAt: number
  aliveAt: number
  // The thread open in it, and whether you're looking at it (visible and focused).
  viewing?: string
  watching?: boolean
  // This browser's push subscription (its endpoint), when it has one.
  push?: string
}
export type TabView = { viewing?: string; watching?: boolean; push?: string }
const maxTabs = 200

export class TabRegistry {
  private tabs = new Map<string, Record>()
  private current: string | undefined
  constructor(private readonly onChange: () => void = () => {}) {}

  report(id: string, event: 'visit' | 'alive' | 'leave', now = Date.now(), view: TabView = {}) {
    if (event === 'leave') this.tabs.delete(id)
    else {
      const tab = this.tabs.get(id)
      this.tabs.set(id, {
        visitedAt: event === 'visit' ? now : (tab?.visitedAt ?? 0),
        aliveAt: now,
        ...(view.viewing ? { viewing: view.viewing } : {}),
        watching: Boolean(view.viewing && view.watching),
        ...(view.push ? { push: view.push } : {}),
      })
    }
    this.prune(now)
    this.update(now)
  }
  // The tab that notifies, or undefined when none is known.
  leader(now = Date.now()) {
    return notifyingTab(Object.fromEntries(this.tabs), now)
  }
  // Whether you're looking at this thread in some open tab right now.
  isWatching(threadId: string, now = Date.now()) {
    for (const tab of this.tabs.values())
      if (tab.watching && tab.viewing === threadId && now - tab.aliveAt < tabStaleMs) return true
    return false
  }
  // Push subscriptions of browsers you're using right now (a t3 mini tab there is visible and
  // focused): they already show the event in the page, so a push to them would be a second one.
  pushInUse(now = Date.now()) {
    const endpoints = new Set<string>()
    for (const tab of this.tabs.values())
      if (tab.watching && tab.push && now - tab.aliveAt < tabStaleMs) endpoints.add(tab.push)
    return endpoints
  }
  private prune(now: number) {
    for (const [id, tab] of this.tabs) if (now - tab.aliveAt >= tabStaleMs) this.tabs.delete(id)
    // Bounded, in case something keeps inventing tab ids.
    while (this.tabs.size > maxTabs) this.tabs.delete(this.tabs.keys().next().value!)
  }
  private update(now: number) {
    const next = this.leader(now)
    if (next === this.current) return
    this.current = next
    this.onChange()
  }
}
