import { buildTurns } from '../timeline'
import type { Message, Provider, Thread } from '../types'
import { turnText } from './shared-thread'

// Switching agents mid-thread (see Thread.handoff). Claude and Codex can't read each other's
// sessions, so the agent taking over gets a recap of the turns it missed in front of its next
// prompt: your messages, a work line when there is one, and the other agent's final answers.
// Files are shared (same folder), so only the conversation needs carrying over. The newest
// turns that fit are sent; older ones are left to read_thread on this thread.

const maxChars = 24_000
const names: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' }

// The newest turns that fit in maxChars, oldest first, and how many older ones were left out.
function recentTurns(turns: ReturnType<typeof buildTurns>, max = maxChars) {
  const picked: string[] = []
  let used = 0
  let first = turns.length
  for (let index = turns.length - 1; index >= 0; index--) {
    const text = turnText(turns[index]!, index + 1)
    if (picked.length && used + text.length > max) break
    picked.unshift(text)
    used += text.length
    first = index
  }
  return { text: picked.join('\n\n'), older: first }
}

// A sub-agent's view of the thread it works for (delegate_task with context "thread"): the
// recent turns, so it knows what the conversation is about. Empty for a thread with no turns.
export function conversationRecap(thread: Thread) {
  const messages = thread.messages.filter((message) => !message.unsent)
  if (!messages.some((message) => message.text.trim())) return ''
  const { text, older } = recentTurns(
    buildTurns({ messages, activities: [], status: 'completed' }),
    16_000,
  )
  return (
    '[For context, the conversation in the thread you work for' +
    (older
      ? ` (its latest turns; ${older} older left out; read_thread with id ${thread.id} reads them)`
      : '') +
    ':]\n\n' +
    text +
    '\n\n[End of context]'
  )
}

// The messages the agent missed: after `after` (all when it's absent or no longer in the
// thread, e.g. edited away) and before the message starting this turn. Unsent ones never went
// to any agent.
export function missedMessages(thread: Thread, startId?: string): Message[] {
  const { messages } = thread
  const afterIndex = thread.handoff?.after
    ? messages.findIndex((message) => message.id === thread.handoff!.after)
    : -1
  const end = startId ? messages.findIndex((message) => message.id === startId) : -1
  return messages
    .slice(afterIndex + 1, end < 0 ? messages.length : end)
    .filter((message) => !message.unsent)
}

// The recap to put before the prompt, or '' when there's nothing to catch up on.
export function handoffRecap(thread: Thread, startId?: string): string {
  if (!thread.handoff) return ''
  const missed = missedMessages(thread, startId)
  if (!missed.some((message) => message.text.trim())) return ''
  const turns = buildTurns({ messages: missed, activities: [], status: 'completed' })
  const others = [
    ...new Set(
      missed.flatMap((message) =>
        message.role === 'user' && message.provider && message.provider !== thread.provider
          ? [names[message.provider]]
          : [],
      ),
    ),
  ]
  const who = others.length
    ? others.join(' and ')
    : names[thread.provider === 'claude' ? 'codex' : 'claude']
  const { text, older: first } = recentTurns(turns)
  const older =
    first > 0
      ? `\n\n(${first} older turn${first === 1 ? '' : 's'} left out. To read the whole ` +
        `conversation, call read_thread with this thread's id ${thread.id}; page back with ` +
        `before.)`
      : ''
  return (
    `[Recap: this thread was switched to you from ${who}. You weren't part of the turns below, ` +
    `so here is what happened in them. Any file changes are already on disk. Use it as ` +
    `context; the user's new message follows the recap.]\n\n` +
    `${text}${older}\n\n[End of recap]\n\n`
  )
}

// Switches a started thread to another agent: parks the current agent's session with the last
// message it saw, brings back the new agent's own session if it had one, and marks what it
// missed for the recap. Its rewind and checklist belonged to the old agent.
export function switchAgent(thread: Thread, to: Provider) {
  const from = thread.provider
  if (from === to) return
  const sessions = { ...thread.sessions }
  if (thread.sessionId) {
    // Still owed a recap (switched to and away again without a turn): it saw only up to there.
    const seen = thread.handoff
      ? thread.handoff.after
      : [...thread.messages].reverse().find((message) => !message.unsent)?.id
    sessions[from] = {
      id: thread.sessionId,
      ...(thread.claudeEntry ? { claudeEntry: thread.claudeEntry } : {}),
      ...(seen ? { seen } : {}),
    }
  }
  const parked = sessions[to]
  delete sessions[to]
  thread.sessionId = parked?.id
  thread.claudeEntry = parked?.claudeEntry
  // Nothing to recap when it saw everything (switched away and straight back).
  const last = [...thread.messages].reverse().find((message) => !message.unsent)
  thread.handoff = !last || last.id === parked?.seen ? undefined : { after: parked?.seen }
  thread.sessions = Object.keys(sessions).length ? sessions : undefined
  thread.rewind = undefined
  thread.todos = undefined
  thread.provider = to
}
