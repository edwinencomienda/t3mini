import type { Block } from './blocks'
import type { Activity, Message, Status } from './types'

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
  | { kind: 'todos'; at: string }

export type Turn = {
  key: string
  // Absent for agent messages before any of yours.
  user?: Message
  // Notes and steps in order (all of the agent's messages while the turn is in progress).
  work: WorkItem[]
  // The agent's last message, once the turn has finished.
  answer?: Message
  // Images (and other tool content) from the folded notes, shown above the answer.
  blocks: Block[]
  done: boolean
  steps: number
  // For the fold line: when the turn started and finished.
  startedAt?: string
  endedAt?: string
}

type ThreadState = {
  messages: Message[]
  activities: Activity[]
  status: Status
  completedAt?: string
}

const running = (status: Status) =>
  status === 'starting' || status === 'working' || status === 'waiting'

export function buildTurns(thread: ThreadState): Turn[] {
  const turns: Turn[] = []
  for (const message of thread.messages) {
    if (message.role === 'user' || !turns.length)
      turns.push({
        key: message.id,
        ...(message.role === 'user' ? { user: message } : {}),
        work: [],
        blocks: [],
        done: true,
        steps: 0,
        ...(message.role === 'user' ? { startedAt: message.createdAt } : {}),
      })
    if (message.role === 'assistant')
      turns.at(-1)!.work.push({ kind: 'note', message, at: message.createdAt })
  }
  if (!turns.length && thread.activities.length)
    turns.push({ key: 'work', work: [], blocks: [], done: true, steps: 0 })
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
        turn.work.push({ kind: 'todos', at: activity.startedAt ?? '' })
      continue
    }
    turn.work.push({ kind: 'step', activity, at: activity.startedAt ?? '' })
    turn.steps++
  }

  const active = running(thread.status)
  turns.forEach((turn, index) => {
    // Notes and dated steps by time; undated steps keep their place after the turn's notes.
    turn.work.sort((a, b) => (a.at && b.at ? a.at.localeCompare(b.at) : a.at ? -1 : b.at ? 1 : 0))
    turn.done = !(active && index >= current)
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
      turn.blocks = turn.work.flatMap((item) =>
        item.kind === 'note' ? (item.message.blocks ?? []) : [],
      )
    }
    const notes = turn.work.filter((item) => item.kind === 'note')
    turn.endedAt =
      index === current && thread.completedAt && turn.done
        ? thread.completedAt
        : (turn.answer?.createdAt ?? notes.at(-1)?.at)
  })
  return turns
}

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
  const notes = turn.work.length - turn.steps
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
