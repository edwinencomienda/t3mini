// Splits plain text into text and links, for the messages you type (agent replies are Markdown
// and get their links from react-markdown). Only http(s) addresses become links, so nothing like
// javascript: can sneak in.

export type TextPart = { text: string; href?: string }

const candidate = /\bhttps?:\/\/[^\s<>"'`]+/gi
// A closing bracket at the end belongs to the link only if the link opened it, e.g.
// https://en.wikipedia.org/wiki/Mercury_(planet) but not "(see https://example.com)".
const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const count = (text: string, char: string) => text.split(char).length - 1

function trim(link: string) {
  while (link) {
    const end = link.at(-1)!
    const open = pairs[end]
    if (open) {
      if (count(link, open) >= count(link, end)) break
    } else if (!/[.,;:!?*_~'"]/.test(end)) break
    link = link.slice(0, -1)
  }
  return link
}
const isWebUrl = (link: string) => {
  try {
    const { protocol, hostname } = new URL(link)
    return (protocol === 'http:' || protocol === 'https:') && Boolean(hostname)
  } catch {
    return false
  }
}

export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(candidate)) {
    const start = match.index
    const link = trim(match[0])
    if (!link || !isWebUrl(link)) continue
    if (start > last) parts.push({ text: text.slice(last, start) })
    parts.push({ text: link, href: link })
    last = start + link.length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
