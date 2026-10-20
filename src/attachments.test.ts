import { expect, it } from 'vitest'
import { formatSize, withAttachedFiles, type PendingAttachment } from './attachments'

const file = (path: string): PendingAttachment => ({
  key: path,
  name: 'Pasted text',
  previewUrl: '',
  status: 'ready',
  path,
})

it('adds pasted text files to the message as paths', () => {
  const image: PendingAttachment = {
    key: 'i',
    name: 'a.png',
    previewUrl: 'blob:x',
    status: 'ready',
    id: 'abc',
  }
  expect(withAttachedFiles('hi', [image])).toBe('hi')
  expect(withAttachedFiles('why?', [file('/data/a/pasted-text.txt')])).toBe(
    'why?\n\nPasted text: /data/a/pasted-text.txt',
  )
  expect(withAttachedFiles('  ', [file('/data/my logs/pasted-text.txt')])).toBe(
    'Pasted text: "/data/my logs/pasted-text.txt"',
  )
})

it('formats sizes', () => {
  expect(formatSize(512)).toBe('512 B')
  expect(formatSize(42_999)).toBe('42 KB')
  expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
})
