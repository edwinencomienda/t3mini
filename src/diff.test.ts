import { expect, it } from 'vitest'
import { parseDiff, splitRows } from './diff'

const sample = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@ export function app() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
\\ No newline at end of file
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/old name.md b/new name.md
similarity index 90%
rename from old name.md
rename to new name.md
diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
Binary files a/logo.png and b/logo.png differ
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
deleted file mode 100644
--- "a/caf\\303\\251.txt"
+++ /dev/null
@@ -1 +0,0 @@
-bye
`

it('parses modified, added, renamed, binary, and deleted files with line numbers', () => {
  const files = parseDiff(sample)
  expect(files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
    ['src/app.ts', 'modified', 2, 1],
    ['new.txt', 'added', 1, 0],
    ['new name.md', 'renamed', 0, 0],
    ['logo.png', 'modified', 0, 0],
    ['café.txt', 'deleted', 0, 1],
  ])
  expect(files[2]?.oldPath).toBe('old name.md')
  expect(files[3]?.binary).toBe(true)
  expect(files[0]?.hunks[0]?.lines).toEqual([
    { type: 'ctx', old: 1, new: 1, text: 'const a = 1' },
    { type: 'del', old: 2, text: 'const b = 2' },
    { type: 'add', new: 2, text: 'const b = 3' },
    { type: 'add', new: 3, text: 'const c = 4' },
    { type: 'ctx', old: 3, new: 4, text: 'const d = 5' },
  ])
})
it('pairs deletions with the additions that replace them for split view', () => {
  const rows = splitRows(parseDiff(sample)[0]!.hunks[0]!.lines)
  expect(rows.map((row) => [row.left?.text, row.right?.text])).toEqual([
    ['const a = 1', 'const a = 1'],
    ['const b = 2', 'const b = 3'],
    [undefined, 'const c = 4'],
    ['const d = 5', 'const d = 5'],
  ])
})
