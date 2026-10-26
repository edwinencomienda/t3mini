import type { Block, DelegationBlock, StatusBlock } from './blocks'
import type { Activity, Message, Status, Todo } from './types'

// How a thread's conversation is laid out, one turn at a time: your message, the agent's work
// (its in-between notes and tool steps, in the order they happened), then its final answer.
// - A turn in progress shows its work live.
// - A finished turn folds its work into one line ("Worked for 2m · 12 steps"), leaving your
//   message and the final answer in view.
// Steps are only kept for the latest run, so older turns fold just their notes.
// Images and diagrams the agent showed you along the way are results, not working detail: when
// a turn folds, they move from its notes to the final answer, above its text (they came first,
// and answers refer to them as "above"), so they stay in view.

export type WorkItem =
  | { kind: 'note'; message: Message; at: string }
  | { kind: 'step'; activity: Activity; at: string }
  // The to-do checklist card, where the agent first wrote its list in this turn.
  | { kind: 'todos'; at: string; todos: Todo[] }

export type Turn = {
  key: string
  // Absent for agent messages before any of yours.
  user?: Message
  // Notes and steps in order (all of the agent's messages while the turn is in progress).
  work: WorkItem[]
  // The agent's last message, once the turn has finished.
  answer?: Message
  // Earlier replies the agent ended a response with (endsReply), shown before the answer instead
  // of being folded away: e.g. its summary, before background work finished and it added more.
  replies: Message[]
  // Images (and other tool content) from the folded notes, shown above the answer.
  blocks: Block[]
  // While the turn runs: its status cards (show_status), kept in view under the working line
  // even though the work is folded. Once it's done they're part of `blocks`, above the answer.
  cards: (StatusBlock | DelegationBlock)[]
  done: boolean
  steps: number
  // The agent's to-do checklist for this turn: live while it runs, then the one saved on the
  // turn's message (Message.todos).
  todos?: Todo[]
  // For the fold line: when the turn started and finished.
  startedAt?: string
  endedAt?: string
}

type ThreadState = {
  messages: Message[]
  activities: Activity[]
  status: Status
  completedAt?: string
  todos?: Todo[]
}

const running = (status: Status) =>
  status === 'starting' || status === 'working' || status === 'waiting'

const noBlocks: Block[] = []
const noCards: (StatusBlock | DelegationBlock)[] = []

export function buildTurns(thread: ThreadState): Turn[] {
  const turns: Turn[] = []
  for (const message of thread.messages) {
    if (message.role === 'user' || !turns.length)
      turns.push({
        key: message.id,
        ...(message.role === 'user' ? { user: message } : {}),
        work: [],
        blocks: [],
        cards: noCards,
        replies: [],
        done: true,
        steps: 0,
        ...(message.role === 'user' ? { startedAt: message.createdAt } : {}),
      })
    if (message.role === 'assistant')
      turns.at(-1)!.work.push({ kind: 'note', message, at: message.createdAt })
  }
  if (!turns.length && thread.activities.length)
    turns.push({
      key: 'work',
      work: [],
      blocks: [],
      cards: noCards,
      replies: [],
      done: true,
      steps: 0,
    })
  if (!turns.length) return turns

  // The turn the current run belongs to: the one started by your latest message that was sent
  // (messages queued during the run start turns of their own, but haven't run yet).
  let current = turns.length - 1
  while (current > 0 && (turns[current]!.user?.queued || turns[current]!.user?.unsent)) current--

  // Steps join the turn whose message came before them; older steps without a start time
  // belong to the current run's turn.
  for (const activity of thread.activities) {
    let index = current
    if (activity.startedAt) {
      index = 0
      turns.forEach((turn, n) => {
        // Never a queued message's turn: those haven't run yet.
        if (n <= current && turn.startedAt && turn.startedAt <= activity.startedAt!) index = n
      })
    }
    const turn = turns[index]!
    // To-do updates become one checklist card (not steps), placed at the first one.
    if (activity.todo) {
      if (!turn.work.some((item) => item.kind === 'todos'))
        turn.work.push({ kind: 'todos', at: activity.startedAt ?? '', todos: [] })
      continue
    }
    turn.work.push({ kind: 'step', activity, at: activity.startedAt ?? '' })
    turn.steps++
  }

  const active = running(thread.status)
  turns.forEach((turn, index) => {
    // The turn's checklist: the live one for the current run (only if this run wrote one, so a
    // list from before turns were given their own can't show up in the wrong turn), otherwise
    // the one saved with the turn. Older turns have no steps left, so the card is added back.
    const live = index === current && turn.work.some((item) => item.kind === 'todos')
    const saved = active && index === current ? undefined : turn.user?.todos
    const todos = saved?.length ? saved : live && thread.todos?.length ? thread.todos : undefined
    if (todos) {
      turn.todos = todos
      const card = turn.work.find((item) => item.kind === 'todos')
      if (card) card.todos = todos
      else turn.work.unshift({ kind: 'todos', at: turn.startedAt ?? '', todos })
    } else turn.work = turn.work.filter((item) => item.kind !== 'todos')
    // Notes and dated steps by time; undated steps keep their place after the turn's notes.
    turn.work.sort((a, b) => (a.at && b.at ? a.at.localeCompare(b.at) : a.at ? -1 : b.at ? 1 : 0))
    turn.done = !(active && index >= current)
    if (!turn.done) {
      const cards = turn.work.flatMap((item) =>
        item.kind === 'note'
          ? (item.message.blocks ?? []).filter(
              (block): block is StatusBlock | DelegationBlock =>
                block.type === 'status' || block.type === 'delegation',
            )
          : [],
      )
      if (cards.length) turn.cards = cards
    }
    if (turn.done) {
      const last = [...turn.work]
        .reverse()
        .find(
          (item) =>
            item.kind === 'note' && (item.message.text.trim() || item.message.blocks?.length),
        )
      if (last?.kind === 'note') {
        turn.answer = last.message
        turn.work = turn.work.filter((item) => item !== last)
      }
      turn.replies = turn.work.flatMap((item) =>
        item.kind === 'note' && item.message.endsReply && item.message.text.trim()
          ? [item.message]
          : [],
      )
      turn.work = turn.work.filter(
        (item) => item.kind !== 'note' || !turn.replies.includes(item.message),
      )
      const blocks = turn.work.flatMap((item) =>
        item.kind === 'note' ? (item.message.blocks ?? []) : [],
      )
      // Shared when empty, so memoized messages handed it don't re-render for a new [].
      turn.blocks = blocks.length ? blocks : noBlocks
    }
    const notes = turn.work.filter((item) => item.kind === 'note')
    turn.endedAt =
      index === current && thread.completedAt && turn.done
        ? thread.completedAt
        : (turn.answer?.createdAt ?? notes.at(-1)?.at)
  })
  return turns
}

// How many of the turn's checklist items aren't done (0 without a checklist).
export const unfinished = (turn: Pick<Turn, 'todos'>) =>
  turn.todos?.filter((todo) => todo.status !== 'completed').length ?? 0

// How long a turn took: "24s", "2m 10s", "1h 5m".
export function turnDuration(turn: Pick<Turn, 'startedAt' | 'endedAt'>) {
  if (!turn.startedAt || !turn.endedAt) return undefined
  const seconds = Math.max(
    1,
    Math.round((Date.parse(turn.endedAt) - Date.parse(turn.startedAt)) / 1000),
  )
  if (!Number.isFinite(seconds)) return undefined
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
const verbs = (status?: Status) =>
  status === 'interrupted'
    ? ['Stopped', 'after']
    : status === 'failed'
      ? ['Failed', 'after']
      : ['Worked', 'for']

// "Worked for 2m 10s · 12 steps" ("Stopped after…" / "Failed after…" for a run that ended
// early), or "· 3 messages" for older turns without saved steps.
export function foldLabel(turn: Turn, status?: Status) {
  const [verb, joiner] = verbs(status)
  const parts = [verb!]
  const time = turnDuration(turn)
  if (time) parts[0] = `${verb} ${joiner} ${time}`
  const notes = turn.work.filter((item) => item.kind === 'note').length
  if (turn.steps) parts.push(`${turn.steps} ${turn.steps === 1 ? 'step' : 'steps'}`)
  else if (notes) parts.push(`${notes} ${notes === 1 ? 'message' : 'messages'}`)
  // The conversation was compacted in this turn (the divider is inside the fold).
  if (
    turn.work.some(
      (item) =>
        item.kind === 'step' && item.activity.compact && item.activity.status === 'completed',
    )
  )
    parts.push('compacted')
  // The turn ended with its checklist unfinished: "2 of 6 left".
  const left = unfinished(turn)
  if (left) parts.push(`${left} of ${turn.todos!.length} left`)
  return parts.join(' · ')
}

// The line at the very bottom of a thread once its latest turn ends, like Claude Code:
// "Worked for 24s · done 2:00 PM" ("Stopped after…" / "Failed after…" when it ended early).
// The date is added when it didn't end today. Undefined without both times.
export function finishLabel(turn: Turn, status?: Status, now = new Date()) {
  const time = turnDuration(turn)
  if (!time || !turn.endedAt) return undefined
  const [verb, joiner] = verbs(status)
  const ended = new Date(turn.endedAt)
  const clock = ended.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const day =
    ended.toDateString() === now.toDateString()
      ? ''
      : `${ended.toLocaleDateString([], { month: 'short', day: 'numeric' })}, `
  const done = status === 'interrupted' || status === 'failed' ? '' : 'done '
  return `${verb} ${joiner} ${time} · ${done}${day}${clock}`
}

// The working line's text while a turn runs: the agent's latest note, but only finished text,
// like Claude Desktop (a note that's still streaming would change word by word). A note is
// finished once anything comes after it in the turn; the last one, maybe still streaming, counts
// only up to its last finished paragraph (one followed by a blank line), never inside an open
// code block. Nothing finished yet: the note before it, or nothing.
export function liveNote(work: WorkItem[]): string | undefined {
  for (let index = work.length - 1; index >= 0; index--) {
    const item = work[index]!
    if (item.kind !== 'note') continue
    const line = noteLine(
      index === work.length - 1 ? finishedText(item.message.text) : item.message.text,
    )
    if (line) return line
  }
}
function finishedText(text: string) {
  const end = text.search(/\n\s*\n(?![\s\S]*\n\s*\n)/)
  let done = end < 0 ? '' : text.slice(0, end)
  // An unclosed code block: up to where it opened.
  if ((done.match(/^\s*```/gm)?.length ?? 0) % 2) done = done.slice(0, done.lastIndexOf('```'))
  return done
}

// The working line's text from the agent's latest note: its last paragraph, as plain words
// (Markdown marks, links, and list bullets dropped), on one line.
export function noteLine(text: string) {
  const paragraph =
    text
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith('```'))
      .at(-1) ?? ''
  return paragraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s+/gm, '')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}
