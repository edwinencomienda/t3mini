// Page snapshots as the agent reads them (browser_open, click, type, snapshot…). Playwright's
// accessibility snapshot of a real app is long: a sidebar with 80 threads repeats the same few
// lines 80 times, and the snapshot is cut at a fixed size, so whatever comes last (often the open
// menu or dialog, which are portaled to the end of the page) was cut off. So:
// - long runs of look-alike siblings (list items, rows, cards with the same shape) keep their
//   first few and say how many more there are;
// - open menus, dialogs, and listboxes come first, since they're usually what the agent just
//   opened and wants to act on.
// browser_snapshot with full: true (or a target) shows everything.

type Node = { line: string; depth: number; children: Node[] }

// A run this long of siblings with the same shape is shortened…
const minRun = 8
// …to its first few.
const keep = 3
const popupRoles = new Set(['dialog', 'alertdialog', 'menu', 'listbox'])

function parse(tree: string): Node {
  const root: Node = { line: '', depth: -1, children: [] }
  const stack = [root]
  for (const line of tree.split('\n')) {
    if (!line.trim()) continue
    const depth = line.search(/\S/)
    const node: Node = { line, depth, children: [] }
    while (stack.length > 1 && stack.at(-1)!.depth >= depth) stack.pop()
    stack.at(-1)!.children.push(node)
    stack.push(node)
  }
  return root
}

// "- link "Home" [ref=e5]:" → "link"; "- /url: /" → "/url". A line whose name has a colon is
// quoted as a whole: "- 'menu "Model: Opus" [ref=e9]':" → "menu".
const role = (node: Node) => /^\s*-\s+['"]?([\w/-]+)/.exec(node.line)?.[1] ?? ''
// Siblings look alike when they have the same role and their children the same roles: a list
// of threads does, a form's fields (textbox, checkbox, button) don't.
const shape = (node: Node) => `${role(node)}(${node.children.map(role).join(',')})`

function render(node: Node, out: string[], skip: Set<Node>) {
  if (node.depth >= 0) out.push(node.line)
  const children = node.children.filter((child) => !skip.has(child))
  for (let index = 0; index < children.length;) {
    let end = index + 1
    while (end < children.length && shape(children[end]!) === shape(children[index]!)) end++
    const run = children.slice(index, end)
    const shown = run.length >= minRun ? run.slice(0, keep) : run
    for (const child of shown) render(child, out, skip)
    if (shown.length < run.length) {
      const first = run[0]!
      out.push(
        `${' '.repeat(first.depth)}- (${run.length - keep} more ${role(first) || 'items'} like these ` +
          'hidden; browser_snapshot with full: true or a target shows them)',
      )
    }
    index = end
  }
}

// Open menus, dialogs, and listboxes, outermost only (a submenu inside a menu stays in it).
function popups(node: Node, found: Node[] = []): Node[] {
  for (const child of node.children) {
    if (popupRoles.has(role(child))) found.push(child)
    else popups(child, found)
  }
  return found
}

export function compactSnapshot(tree: string, options: { full?: boolean } = {}): string {
  if (options.full || !tree.trim()) return tree
  const root = parse(tree)
  const open = popups(root)
  const page: string[] = []
  render(root, page, new Set(open))
  if (!open.length) return page.join('\n')
  const shown = open.map((popup) => {
    const lines: string[] = []
    render(popup, lines, new Set())
    // Re-indented to the left edge, as their own little trees.
    return lines.map((line) => line.slice(popup.depth)).join('\n')
  })
  return `Open now (menus and dialogs):\n${shown.join('\n')}\n\nPage:\n${page.join('\n')}`
}
