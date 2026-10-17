import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Fresh module state for each test.
let shared: typeof import('./shared-settings')
let requests: unknown[]
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response('{}')
    }),
  )
  shared = await import('./shared-settings')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('adopts the server’s settings, and only when they change', () => {
  const adopt = vi.fn()
  shared.registerShared('theme', () => undefined, adopt)
  shared.applyShared({ groupBy: 'project', theme: 'dark' })
  shared.applyShared({ groupBy: 'project', theme: 'dark' })
  expect(adopt).toHaveBeenCalledTimes(1)
  shared.applyShared({ groupBy: 'project', theme: 'light' })
  expect(adopt).toHaveBeenLastCalledWith('light')
})

it('carries this browser’s choice over once when the server has none', async () => {
  shared.registerShared('projectIcons', () => false, vi.fn())
  shared.registerShared('theme', () => undefined, vi.fn())
  shared.applyShared({ groupBy: 'project' })
  await vi.advanceTimersByTimeAsync(300)
  expect(requests).toEqual([{ projectIcons: false }])
})

it('saves changes, merging quick repeats, and ignores its own echo', async () => {
  const adopt = vi.fn()
  shared.registerShared('music', () => undefined, adopt)
  for (const volume of [10, 20, 30])
    shared.shareSetting({ music: { enabled: true, url: '', volume } })
  await vi.advanceTimersByTimeAsync(300)
  expect(requests).toEqual([{ music: { enabled: true, url: '', volume: 30 } }])
  shared.applyShared({ groupBy: 'project', music: { enabled: true, url: '', volume: 30 } })
  expect(adopt).not.toHaveBeenCalled()
})
