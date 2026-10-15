import { expect, it } from 'vitest'
import { describeClaudeTool, describeCodexItem, toolOutput, unwrapShell } from './activity'

const cwd = '/work/app'

it('summarizes common Claude tools with the command, path, or query', () => {
  expect(
    describeClaudeTool(
      'Bash',
      { command: 'git log -1 --stat\necho done', description: 'Show last commit' },
      cwd,
    ),
  ).toEqual({
    label: 'Run',
    summary: 'git log -1 --stat',
    detail: '# Show last commit\ngit log -1 --stat\necho done',
  })
  expect(describeClaudeTool('Read', { file_path: '/work/app/src/a.ts' }, cwd)).toMatchObject({
    label: 'Read',
    summary: 'src/a.ts',
  })
  expect(
    describeClaudeTool(
      'Edit',
      { file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' },
      cwd,
    ),
  ).toEqual({ label: 'Edit', summary: 'a.ts', detail: '- a\n+ b' })
  expect(describeClaudeTool('Grep', { pattern: 'TODO', path: '/work/app/src' }, cwd).summary).toBe(
    '"TODO" in src',
  )
  expect(describeClaudeTool('mcp__github__create_issue', { title: 'x' }, cwd)).toMatchObject({
    label: 'create_issue',
    summary: 'github',
  })
})
it('reads tool output from strings and text blocks', () => {
  expect(toolOutput('hello\n')).toBe('hello')
  expect(
    toolOutput([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
  ).toBe('a\nb')
  expect(toolOutput('')).toBeUndefined()
  expect(toolOutput('x'.repeat(9000))).toContain('more characters')
})
it('summarizes Codex commands, file changes, and failures', () => {
  expect(unwrapShell(`/bin/zsh -lc 'npm test'`)).toBe('npm test')
  expect(
    describeCodexItem(
      {
        type: 'commandExecution',
        command: `bash -lc "npm test"`,
        aggregatedOutput: 'fail\n',
        exitCode: 1,
      },
      cwd,
    ),
  ).toEqual({
    label: 'Run',
    summary: 'npm test',
    detail: 'npm test',
    output: 'fail\n[exit code 1]',
  })
  expect(
    describeCodexItem(
      {
        type: 'fileChange',
        changes: [
          { path: '/work/app/a.ts', diff: '+x' },
          { path: '/work/app/b.ts', diff: '+y' },
          { path: '/work/app/c.ts', diff: '+z' },
        ],
      },
      cwd,
    ).summary,
  ).toBe('a.ts, b.ts +1 more')
})
