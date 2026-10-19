// Group by date in the sidebar: Today, Yesterday, This week (the rest of the last 7 days), and
// Older, by when you last wrote in each thread (the list's own order, so each section stays in
// one piece), in local time. Empty sections are left out.
type Dated = { lastMessageAt: string }

export function dateSections<T extends Dated>(items: T[], now: number) {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  // Calendar days, so a day that's 23 or 25 hours long (daylight saving) still counts as one.
  const daysBack = (days: number) => {
    const date = new Date(start)
    date.setDate(date.getDate() - days)
    return date.getTime()
  }
  const starts = [
    { label: 'Today', from: start },
    { label: 'Yesterday', from: daysBack(1) },
    { label: 'This week', from: daysBack(6) },
    { label: 'Older', from: -Infinity },
  ]
  const sections = starts.map((section) => ({ label: section.label, items: [] as T[] }))
  for (const item of items) {
    const at = Date.parse(item.lastMessageAt)
    const index = Number.isNaN(at) ? -1 : starts.findIndex((section) => at >= section.from)
    sections[index < 0 ? sections.length - 1 : index]!.items.push(item)
  }
  return sections.filter((section) => section.items.length)
}
