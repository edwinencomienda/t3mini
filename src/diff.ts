// A small unified-diff parser for `git diff` output. Shared by the server (parsing) and the
// client (types and split-view pairing).
export type DiffLine = { type: 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string }
export type DiffHunk = { header: string; lines: DiffLine[] }
export type DiffFile = {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  additions: number
  deletions: number
  binary: boolean
  // Too many changed lines to show; counts are still accurate.
  tooLarge?: boolean
  hunks: DiffHunk[]
}
export type DiffResult = {
  repo: boolean
  files: DiffFile[]
  truncated: boolean
  // All changed files, including those beyond the cap that aren't in `files`.
  totalFiles: number
}

// git quotes unusual paths ("a/na\303\257ve.txt"); unquote and drop the a/ or b/ prefix.
function cleanPath(raw: string) {
  let path = raw.trim()
  if (path.startsWith('"') && path.endsWith('"')) {
    const bytes: number[] = []
    const body = path.slice(1, -1)
    for (let index = 0; index < body.length; index++) {
      const char = body[index]!
      if (char !== '\\') {
        bytes.push(...new TextEncoder().encode(char))
        continue
      }
      const next = body[++index]!
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(body.slice(index, index + 3), 8))
        index += 2
      } else
        bytes.push(
          ({ n: 10, t: 9, '"': 34, '\\': 92 } as Record<string, number>)[next] ??
            next.charCodeAt(0),
        )
    }
    path = new TextDecoder().decode(new Uint8Array(bytes))
  }
  return path === '/dev/null' ? path : path.replace(/^[ab]\//, '')
}

export function parseDiff(output: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: DiffHunk | undefined
  let oldLine = 0
  let newLine = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (.+?) (b\/.+|"b\/.+")$/.exec(line)
      file = {
        path: cleanPath(match?.[2] ?? line.slice(11)),
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      }
      hunk = undefined
      files.push(file)
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = cleanPath(line.slice(12))
      } else if (line.startsWith('rename to ')) file.path = cleanPath(line.slice(10))
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))
        file.binary = true
      else if (line.startsWith('+++ ')) {
        const path = cleanPath(line.slice(4))
        if (path !== '/dev/null') file.path = path
      }
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', new: newLine++, text: line.slice(1) })
      file.additions++
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', old: oldLine++, text: line.slice(1) })
      file.deletions++
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ type: 'ctx', old: oldLine++, new: newLine++, text: line.slice(1) })
    }
    // "\ No newline at end of file" and blank trailing lines are ignored.
  }
  return files
}

// Side-by-side rows: context on both sides; a run of deletions pairs with the additions after it.
export type SplitRow = { left?: DiffLine; right?: DiffLine }
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    if (line.type === 'ctx') {
      rows.push({ left: line, right: line })
      index++
      continue
    }
    const deleted: DiffLine[] = []
    const added: DiffLine[] = []
    while (lines[index]?.type === 'del') deleted.push(lines[index++]!)
    while (lines[index]?.type === 'add') added.push(lines[index++]!)
    for (let row = 0; row < Math.max(deleted.length, added.length); row++)
      rows.push({ left: deleted[row], right: added[row] })
  }
  return rows
}
