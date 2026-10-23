import type { StatusBlock } from '../blocks'
import type { Message } from '../types'
import type { StatusCard } from './tools/types'

// Status cards (show_status) in a thread's messages: found per turn, updated in place by id, and
// stopped when a turn ends while they're still running. The turn is the replies after the
// message that started it (from: its index, or -1 for the whole thread), so a later turn that
// reuses an id like "deploy" gets a card of its own.

// This turn's status cards, newest first.
export function turnStatusCards(messages: Message[], from: number) {
  const cards: { message: Message; block: StatusBlock }[] = []
  for (let index = messages.length - 1; index > from; index--) {
    const message = messages[index]!
    for (const block of message.blocks ?? [])
      if (block.type === 'status') cards.push({ message, block })
  }
  return cards
}

// Updates this turn's card with the same id (fields left out keep their value) and returns true,
// or returns false when there's none yet, for the caller to add `newStatusBlock(card)`.
export function updateStatusCard(messages: Message[], from: number, card: StatusCard, now: string) {
  const found = turnStatusCards(messages, from).find(({ block }) => block.id === card.id)
  if (!found) return false
  const { message, block } = found
  const next: StatusBlock = {
    ...block,
    ...card,
    // Back to running (a retry) clears the end; finishing keeps the first finish time.
    endedAt: card.status === 'running' ? undefined : (block.endedAt ?? now),
  }
  message.blocks = message.blocks!.map((item) => (item === block ? next : item))
  return true
}

export function newStatusBlock(card: StatusCard, now: string): StatusBlock {
  return {
    type: 'status',
    ...card,
    startedAt: now,
    ...(card.status === 'running' ? {} : { endedAt: now }),
  }
}

// When a turn ends: its cards still running didn't finish (so none spins forever).
export function stopRunningCards(messages: Message[], from: number, now: string) {
  for (const { message, block } of turnStatusCards(messages, from))
    if (block.status === 'running') {
      const stopped: StatusBlock = { ...block, status: 'stopped', endedAt: now }
      message.blocks = message.blocks!.map((item) => (item === block ? stopped : item))
    }
}
