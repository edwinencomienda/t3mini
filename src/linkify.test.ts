import { expect, it } from 'vitest'
import { linkify } from './linkify'

const links = (text: string) =>
  linkify(text)
    .filter((part) => part.href)
    .map((part) => part.href)

it('finds http and https links and keeps the text around them', () => {
  expect(linkify('see https://github.com/x/y/pull/7 please')).toEqual([
    { text: 'see ' },
    { text: 'https://github.com/x/y/pull/7', href: 'https://github.com/x/y/pull/7' },
    { text: ' please' },
  ])
  expect(links('local http://127.0.0.1:4310/threads/abc?x=1#top and more')).toEqual([
    'http://127.0.0.1:4310/threads/abc?x=1#top',
  ])
  expect(linkify('no links here')).toEqual([{ text: 'no links here' }])
})
it('leaves sentence punctuation and outer brackets out of the link', () => {
  expect(links('Done: https://example.com.')).toEqual(['https://example.com'])
  expect(links('(see https://example.com/a)')).toEqual(['https://example.com/a'])
  expect(links('really? https://example.com/b?, and "https://example.com/c"')).toEqual([
    'https://example.com/b',
    'https://example.com/c',
  ])
  // A bracket the link opened stays.
  expect(links('https://en.wikipedia.org/wiki/Mercury_(planet).')).toEqual([
    'https://en.wikipedia.org/wiki/Mercury_(planet)',
  ])
})
it('finds several links, on any line', () => {
  expect(links('one https://a.example\ntwo https://b.example/x')).toEqual([
    'https://a.example',
    'https://b.example/x',
  ])
})
it('only links web addresses', () => {
  expect(links('javascript:alert(1) ftp://files.example mailto:me@example.com')).toEqual([])
  expect(links('xhttps://example.com')).toEqual([])
  expect(links('https://')).toEqual([])
})
