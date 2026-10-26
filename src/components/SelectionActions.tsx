import { memo, useEffect, useMemo, useState, type RefObject } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Menu } from '@base-ui/react/menu'
import { Check, ChevronDown, Copy, MessageCircleQuestion, MessageSquareQuote } from 'lucide-react'
import { copyText } from '../attachments'

// Ask: a question sent with the selection quoted above it, in one click.
export const askPresets = ['Explain this', 'Why?', 'Is this right?'] as const

// Highlight text in the chat and a small bar appears above it with things to do with it; for
// now "Add to chat" (quotes it into the composer), "Ask" (sends a preset question about it), and
// "Copy". Base UI's Popover places and dismisses it, anchored to the selection itself (a virtual
// element). It keeps its own state, so selecting text never re-renders the chat.
export const SelectionActions = memo(function SelectionActions({
  root,
  onQuote,
  onAsk,
}: {
  // The chat's scroll area: only selections inside it count.
  root: RefObject<HTMLElement | null>
  onQuote: (text: string) => void
  onAsk: (text: string, question: string) => void
}) {
  const [selection, setSelection] = useState<{ range: Range; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  // Clears the highlight first: clearing it after would also drop the composer's cursor.
  const done = () => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }
  useEffect(() => {
    // Shown once the selection is made (pointer up, or shift+arrows), not while dragging.
    const check = () => {
      const current = window.getSelection()
      const element = root.current
      if (!current || current.isCollapsed || !current.rangeCount || !element) return
      const range = current.getRangeAt(0)
      if (!element.contains(range.commonAncestorContainer)) return
      const text = current.toString().trim()
      if (text) setSelection({ range: range.cloneRange(), text })
    }
    const onPointerUp = () => setTimeout(check, 0)
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.shiftKey) check()
    }
    // Hidden as soon as the selection goes away (a click elsewhere, Esc, typing).
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed) setSelection(null)
    }
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [root])
  // Follows the selection as the chat scrolls (contextElement lets Base UI watch that scroll).
  const anchor = useMemo(
    () =>
      selection && {
        getBoundingClientRect: () => selection.range.getBoundingClientRect(),
        getClientRects: () => selection.range.getClientRects(),
        contextElement: root.current ?? undefined,
      },
    [selection, root],
  )
  return (
    <Popover.Root
      open={Boolean(selection)}
      onOpenChange={(open) => {
        if (!open) setSelection(null)
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          className="selection-actions-positioner"
          anchor={anchor}
          side="top"
          sideOffset={8}
          collisionPadding={8}
        >
          {/* No focus moves: the highlight stays, so it can still be copied. */}
          <Popover.Popup className="selection-actions" initialFocus={false} finalFocus={false}>
            <button
              type="button"
              // Keeps the selection while clicking.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!selection) return
                done()
                onQuote(selection.text)
              }}
            >
              <MessageSquareQuote size={14} aria-hidden />
              Add to chat
            </button>
            <Menu.Root>
              <Menu.Trigger
                className="selection-ask"
                onMouseDown={(event) => event.preventDefault()}
              >
                <MessageCircleQuestion size={14} aria-hidden />
                Ask
                <ChevronDown size={12} aria-hidden />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner className="context-menu-positioner" sideOffset={6} align="start">
                  <Menu.Popup className="context-menu" aria-label="Ask about the selection">
                    {askPresets.map((question) => (
                      <Menu.Item
                        key={question}
                        label={question}
                        onClick={() => {
                          if (!selection) return
                          done()
                          onAsk(selection.text, question)
                        }}
                      >
                        {question}
                      </Menu.Item>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
            <button
              type="button"
              aria-label={copied ? 'Copied' : 'Copy'}
              title={copied ? 'Copied' : 'Copy'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!selection) return
                void copyText(selection.text).then(
                  () => setCopied(true),
                  () => {},
                )
              }}
            >
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
})

// The selected text as a Markdown quote, followed by an empty line to write under it.
export function quote(text: string) {
  return `${text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')}\n\n`
}
