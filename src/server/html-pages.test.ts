import { expect, it } from 'vitest'
import type { Message } from '../types'
import { replaceHtmlBlock } from './html-pages'

const reply = (id: string, key: string): Message => ({
  id: `m-${id}`,
  role: 'assistant',
  text: '',
  createdAt: '',
  blocks: [{ type: 'html', id, key }],
})

it('replaces this turn’s page with the same key, never an earlier turn’s', () => {
  const messages: Message[] = [
    reply('old.html', 'chart'),
    { id: 'u', role: 'user', text: 'again', createdAt: '' },
    reply('a.html', 'chart'),
  ]
  expect(replaceHtmlBlock(messages, 1, { type: 'html', id: 'b.html', key: 'chart' })).toBe(true)
  expect(messages[2]!.blocks).toEqual([{ type: 'html', id: 'b.html', key: 'chart' }])
  expect(messages[0]!.blocks).toEqual([{ type: 'html', id: 'old.html', key: 'chart' }])
  expect(replaceHtmlBlock(messages, 1, { type: 'html', id: 'c.html', key: 'other' })).toBe(false)
  expect(replaceHtmlBlock(messages, 1, { type: 'html', id: 'c.html' })).toBe(false)
})
