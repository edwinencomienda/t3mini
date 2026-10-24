import { describe, expect, it } from 'vitest'
import { compactSnapshot } from './snapshot-text'

const sidebarItem = (n: number) =>
  [
    `    - listitem [ref=e${n}0]:`,
    `      - link "Thread ${n}" [ref=e${n}1]:`,
    `        - /url: /threads/${n}`,
    `      - button "More actions for Thread ${n}" [ref=e${n}2]`,
  ].join('\n')

describe('compactSnapshot', () => {
  it('shortens long runs of look-alike siblings and says how many are hidden', () => {
    const tree = [
      '- navigation "Threads" [ref=e1]:',
      '  - list [ref=e2]:',
      ...Array.from({ length: 20 }, (_, index) => sidebarItem(index + 1)),
      '- main [ref=e3]:',
      '  - heading "Hello" [level=1] [ref=e4]',
    ].join('\n')
    const compact = compactSnapshot(tree)
    expect(compact).toContain('Thread 1"')
    expect(compact).toContain('Thread 3"')
    expect(compact).not.toContain('Thread 4"')
    expect(compact).toContain('(17 more listitem like these hidden')
    // What comes after the list is still there.
    expect(compact).toContain('heading "Hello"')
    // full keeps everything.
    expect(compactSnapshot(tree, { full: true })).toBe(tree)
  })

  it('keeps short runs and siblings of different shapes', () => {
    const form = [
      '- form [ref=e1]:',
      ...Array.from({ length: 10 }, (_, index) =>
        index % 2
          ? `  - textbox "Field ${index}" [ref=e${index + 10}]`
          : `  - checkbox "Box ${index}" [ref=e${index + 10}]`,
      ),
    ].join('\n')
    expect(compactSnapshot(form)).toBe(form)
  })

  it('finds menus whose quoted line has a colon in the name', () => {
    const tree = [
      '- main [ref=e1]:',
      '  - button "Send" [ref=e2]',
      `- 'menu "Model: Opus 5.5" [ref=e3]':`,
      `  - menuitem "Effort" [ref=e4]`,
    ].join('\n')
    expect(compactSnapshot(tree)).toMatch(
      /^Open now \(menus and dialogs\):\n- 'menu "Model: Opus 5.5"/,
    )
  })

  it('puts open menus and dialogs first, so a cut never drops them', () => {
    const tree = [
      '- generic [ref=e1]:',
      '  - main [ref=e2]:',
      '    - button "Model: Opus" [ref=e3]',
      '- menu "Model" [ref=e4]:',
      '  - menuitem "Opus" [ref=e5]',
      '  - menuitem "Sonnet" [ref=e6]',
    ].join('\n')
    const compact = compactSnapshot(tree)
    expect(compact.startsWith('Open now (menus and dialogs):\n- menu "Model" [ref=e4]:')).toBe(true)
    expect(compact).toContain('  - menuitem "Sonnet" [ref=e6]')
    // Shown once, not again in the page.
    expect(compact.match(/menu "Model"/g)).toHaveLength(1)
    expect(compact).toContain('Page:\n- generic [ref=e1]:')
  })
})
