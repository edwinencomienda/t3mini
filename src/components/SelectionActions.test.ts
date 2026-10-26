import { expect, it } from 'vitest'
import { quote } from './SelectionActions'

it('quotes selected text as Markdown, with an empty line to write under it', () => {
  expect(quote('one line')).toBe('> one line\n\n')
  expect(quote('first\n\nsecond')).toBe('> first\n>\n> second\n\n')
})
