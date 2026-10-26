import type { HtmlBlock } from '../blocks'
import type { Message } from '../types'

// show_html pages in a thread's messages, by the agent's key. A page shown again with the same
// key in the same turn replaces the first (the agent fixing what the render check found), so
// the reply doesn't collect broken drafts. The turn is the replies after the message that
// started it (from: its index, or -1 for the whole thread); a later turn's page with that key
// is a new one.
export function replaceHtmlBlock(messages: Message[], from: number, next: HtmlBlock) {
  if (!next.key) return false
  for (let index = messages.length - 1; index > from; index--) {
    const message = messages[index]!
    const found = message.blocks?.find((block) => block.type === 'html' && block.key === next.key)
    if (!found) continue
    message.blocks = message.blocks!.map((block) => (block === found ? next : block))
    return true
  }
  return false
}
