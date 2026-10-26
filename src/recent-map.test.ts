import { expect, it } from 'vitest'
import { RecentMap } from './recent-map'

it('keeps only the most recently used entries', () => {
  const map = new RecentMap<string, number>(2)
  map.set('a', 1).set('b', 2)
  expect(map.get('a')).toBe(1) // a is now the most recent
  map.set('c', 3)
  expect([...map.keys()]).toEqual(['a', 'c'])
  expect(map.get('b')).toBeUndefined()
})
