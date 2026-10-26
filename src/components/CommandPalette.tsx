import { useEffect, useState, type ReactNode } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { MessageSquare, Search } from 'lucide-react'
import type { MessageMatch, ThreadSummary } from '../types'
import { Modal } from './Modal'

// ⌘K / Ctrl+K: jump to any thread by its title or project, find a conversation by something
// said in it ("In messages", searched on the server), or run a few app commands. Built on Base
// UI's Autocomplete rendered inline in a Dialog: ↑/↓ to move, Enter to open, Esc to close.

export type PaletteCommand = { id: string; label: string; shortcut?: string; run: () => void }
type Entry = {
  id: string
  label: string
  detail?: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  // Unread threads have a bold title, as in the sidebar.
  bold?: boolean
  run: () => void
}
type Group = { label: string; items: Entry[] }

const recentCount = 8
const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)
const matches = (text: string, terms: string[]) => {
  const value = text.toLowerCase()
  return terms.every((term) => value.includes(term))
}

export function CommandPalette({
  threads,
  commands,
  projectName,
  status,
  isUnread,
  onOpenThread,
  onClose,
}: {
  // Newest first, as in the sidebar.
  threads: ThreadSummary[]
  commands: PaletteCommand[]
  projectName: (path: string) => string
  // The sidebar's time, which doubles as the status ("3m", working dots, "Question"…).
  status: (thread: ThreadSummary) => ReactNode
  isUnread: (thread: ThreadSummary) => boolean
  // With target: a match inside the conversation, opened at that message.
  onOpenThread: (id: string, target?: { message: string; query: string }) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ query: string; matches: MessageMatch[] }>({
    query: '',
    matches: [],
  })
  const trimmed = query.trim()

  // Conversations are searched on the server (it holds the messages), shortly after typing stops.
  useEffect(() => {
    if (trimmed.length < 2) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : { matches: [] }))
        .then((data: { matches?: MessageMatch[] }) =>
          setFound({ query: trimmed, matches: data.matches ?? [] }),
        )
        .catch(() => {})
    }, 150)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [trimmed])

  const run = (action: () => void) => () => {
    onClose()
    action()
  }
  const terms = words(trimmed)
  const threadEntry = (thread: ThreadSummary): Entry => ({
    id: `thread:${thread.id}`,
    label: thread.title,
    detail: projectName(thread.cwd),
    hint: status(thread),
    bold: isUnread(thread),
    run: run(() => onOpenThread(thread.id)),
  })
  const titled = terms.length
    ? threads.filter((thread) => matches(`${thread.title} ${projectName(thread.cwd)}`, terms))
    : threads.slice(0, recentCount)
  const shown = new Set(titled.map((thread) => thread.id))
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const inMessages =
    terms.length && found.query === trimmed
      ? found.matches.filter((match) => !shown.has(match.threadId) && byId.has(match.threadId))
      : []
  const groups: Group[] = [
    {
      label: terms.length ? 'Threads' : 'Recent threads',
      items: titled.map(threadEntry),
    },
    {
      label: 'In messages',
      items: inMessages.map((match) => ({
        id: `message:${match.threadId}`,
        label: match.title,
        detail: (
          <>
            {projectName(match.cwd)} ·{' '}
            <span className="palette-role">{match.role === 'user' ? 'You' : 'Agent'}:</span>{' '}
            {match.snippet}
          </>
        ),
        hint: status(byId.get(match.threadId)!),
        icon: <MessageSquare size={13} />,
        run: run(() =>
          onOpenThread(match.threadId, { message: match.messageId, query: found.query }),
        ),
      })),
    },
    {
      label: 'Commands',
      items: commands
        .filter((command) => !terms.length || matches(command.label, terms))
        .map((command) => ({
          id: `command:${command.id}`,
          label: command.label,
          hint: command.shortcut,
          run: run(command.run),
        })),
    },
  ].filter((group) => group.items.length)

  return (
    <Modal className="new-dialog command-palette" label="Search threads" onClose={onClose}>
      <Autocomplete.Root
        inline
        open
        items={groups}
        filteredItems={groups}
        autoHighlight="always"
        keepHighlight
        value={query}
        onValueChange={(value, details) => {
          // Picking an item runs it; it shouldn't write the item's name into the search box.
          if (details.reason !== 'item-press') setQuery(value)
        }}
        itemToStringValue={(item: Entry) => item.label}
      >
        <label className="palette-search">
          <Search size={16} aria-hidden />
          <Autocomplete.Input
            className="palette-input"
            placeholder="Search threads and messages…"
            autoFocus
            maxLength={200}
          />
        </label>
        <Autocomplete.Empty className="palette-empty">
          {trimmed ? 'Nothing matches.' : 'No threads yet.'}
        </Autocomplete.Empty>
        <Autocomplete.List className="palette-list">
          {(group: Group) => (
            <Autocomplete.Group key={group.label} items={group.items} className="palette-group">
              <Autocomplete.GroupLabel className="palette-group-label">
                {group.label}
              </Autocomplete.GroupLabel>
              <Autocomplete.Collection>
                {(item: Entry) => (
                  <Autocomplete.Item
                    key={item.id}
                    value={item}
                    className="palette-item"
                    onClick={item.run}
                  >
                    {item.icon ? <span className="palette-icon">{item.icon}</span> : null}
                    <span className="palette-text">
                      <span className={`palette-label ${item.bold ? 'unread' : ''}`}>
                        {item.label}
                      </span>
                      {item.detail ? <span className="palette-detail">{item.detail}</span> : null}
                    </span>
                    {item.hint ? <span className="palette-hint">{item.hint}</span> : null}
                  </Autocomplete.Item>
                )}
              </Autocomplete.Collection>
            </Autocomplete.Group>
          )}
        </Autocomplete.List>
      </Autocomplete.Root>
    </Modal>
  )
}
