import { expect, it } from 'vitest'
import { dateSections } from './sidebar-groups'

// Local times: noon on Wednesday 15 October 2026.
const now = new Date(2026, 9, 15, 12, 0).getTime()
const at = (day: number, hour: number) => ({
  id: `${day}-${hour}`,
  lastMessageAt: new Date(2026, 9, day, hour, 0).toISOString(),
})

it('groups threads into Today, Yesterday, This week, and Older, in their own order', () => {
  const items = [
    at(15, 11),
    at(15, 0),
    at(14, 23),
    at(14, 0),
    at(13, 9),
    at(9, 1),
    at(8, 23),
    at(1, 8),
  ]
  expect(
    dateSections(items, now).map((section) => [
      section.label,
      section.items.map((item) => item.id),
    ]),
  ).toEqual([
    ['Today', ['15-11', '15-0']],
    ['Yesterday', ['14-23', '14-0']],
    // The rest of the last 7 days: back to the 9th (today is the 15th).
    ['This week', ['13-9', '9-1']],
    ['Older', ['8-23', '1-8']],
  ])
})

it('leaves out empty sections, and puts unreadable dates under Older', () => {
  expect(dateSections([at(1, 8), { id: 'x', lastMessageAt: 'not a date' }], now)).toEqual([
    { label: 'Older', items: [at(1, 8), { id: 'x', lastMessageAt: 'not a date' }] },
  ])
  expect(dateSections([], now)).toEqual([])
})
