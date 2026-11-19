// A streaming reply is re-rendered ten times a second; parsing all of it each time costs ~12 ms
// for a 30 KB reply. Cut into pieces that parse the same alone, only the last piece changes, so
// the rest come from the parse cache. Used only while a reply streams (a finished reply is
// parsed whole), so a cut that renders slightly differently can only show for a moment.

// Lines that may continue the block before them even after a blank line: list items, quotes,
// tables, footnotes and link definitions, and anything indented (list content, indented code).
const continues = /^(\s|[-*+](\s|$)|\d{1,9}[.)](\s|$)|>|\||\[)/
const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/

// The text in pieces, cut only before a complete line that starts a new top-level block after a
// blank line, outside fenced code. Joined, the pieces are the text.
export function markdownChunks(text: string): string[] {
  const lines = text.split('\n')
  const chunks: string[] = []
  let start = 0
  let fence: string | undefined
  let afterBlank = false
  // The last line may still be arriving ("1" becoming "1. item"), so it never starts a piece.
  for (let index = 0; index < lines.length - 1; index++) {
    const line = lines[index]!
    const marker = fenceLine.exec(line)
    if (fence) {
      // A closing fence: the same character, at least as long, nothing after it.
      if (
        marker &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined
      afterBlank = false
      continue
    }
    if (afterBlank && line.trim() && index > start && !continues.test(line)) {
      chunks.push(lines.slice(start, index).join('\n') + '\n')
      start = index
    }
    if (marker) fence = marker[1]
    afterBlank = !line.trim()
  }
  chunks.push(lines.slice(start).join('\n'))
  return chunks
}
