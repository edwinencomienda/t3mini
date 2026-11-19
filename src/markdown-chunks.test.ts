import { expect, it } from 'vitest'
import { markdownChunks } from './markdown-chunks'

it('cuts a streaming reply between top-level blocks, and the pieces join back to the text', () => {
  const text = '# Plan\n\nFirst paragraph.\n\nSecond paragraph\nstill going.\n\nThird\n'
  const chunks = markdownChunks(text)
  expect(chunks).toEqual([
    '# Plan\n\n',
    'First paragraph.\n\n',
    'Second paragraph\nstill going.\n\n',
    'Third\n',
  ])
  expect(chunks.join('')).toBe(text)
})

it('never cuts where the next block may continue the one before', () => {
  const cases = [
    // Loose list items, an indented continuation, quotes, tables, definitions, indented code.
    '- one\n\n- two\n\nAfter\n',
    '1. one\n\n2. two\n\nAfter\n',
    '- item\n\n  more of the item\n\nAfter\n',
    '> quote\n\n> more quote\n\nAfter\n',
    '| a |\n|---|\n\n| b |\n\nAfter\n',
    'See [x].\n\n[x]: https://example.com\n\nAfter\n',
    'Text\n\n    indented code\n\nAfter\n',
  ]
  // Each block stays whole; the only cut is before "After".
  for (const text of cases)
    expect(markdownChunks(text)).toEqual([text.slice(0, -'After\n'.length), 'After\n'])
})

it('never cuts inside fenced code, even across blank lines', () => {
  const text = 'Run:\n\n```sh\necho one\n\necho two\n```\n\nDone\n\n~~~\nx\n\ny\n~~~'
  expect(markdownChunks(text)).toEqual([
    'Run:\n\n',
    '```sh\necho one\n\necho two\n```\n\n',
    'Done\n\n',
    '~~~\nx\n\ny\n~~~',
  ])
  // An unclosed fence (still streaming) keeps the rest together.
  expect(markdownChunks('Intro\n\n```\na\n\nb')).toEqual(['Intro\n\n', '```\na\n\nb'])
})

it('doesn’t cut before a line that is still arriving', () => {
  // "1" may become "1. item" (a list continuing): wait for the line to finish.
  expect(markdownChunks('- one\n\n1')).toEqual(['- one\n\n1'])
  expect(markdownChunks('- one\n\n1. two\n')).toEqual(['- one\n\n1. two\n'])
  expect(markdownChunks('Para\n\nNext line\n')).toEqual(['Para\n\n', 'Next line\n'])
})
