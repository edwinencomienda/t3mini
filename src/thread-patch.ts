import type { Thread } from './types'

// Live updates for the open thread (/api/events): instead of the whole thread (hundreds of KB
// in a long one) ten times a second while a reply streams, each tab gets the full thread once
// and then only what changed: the thread's own fields when any of them changed, and the messages
// and steps that differ, by position. Shared by the server (ThreadDiff) and the browser
// (applyThreadPatch).

// A list's new length and the items that differ from the previous list, by index. Items past the
// old end are always included, so the list can be rebuilt from the previous one.
export type ListPatch<T> = { count: number; changed: [number, T][] }
type Message = Thread['messages'][number]
// For tabs that ask (`append=1`): a message whose only change is more text at the end comes as
// [index, length it had, the new text] instead of whole, so a streaming reply costs what it
// grew by, not its whole length, on every update.
export type MessagesPatch = ListPatch<Message> & { appended?: [number, number, string][] }
type Rest = Omit<Thread, 'messages' | 'activities'>
export type ThreadPatch = {
  id: string
  // Every field but the lists, whole, when any of them changed.
  rest?: Rest
  messages?: MessagesPatch
  activities?: ListPatch<Thread['activities'][number]>
}
// A message's JSON without its text: equal shapes mean only the text changed.
const shapeOf = (message: Message) => JSON.stringify({ ...message, text: '' })

type Activity = Thread['activities'][number]
type MessageEntry =
  | {
      ref: Message
      json?: undefined
      id: string
      role: Message['role']
      text: string
      createdAt: string
      queued: Message['queued']
      unsent: Message['unsent']
      rewindFailed: Message['rewindFailed']
      answered: Message['answered']
      provider: Message['provider']
      endsReply: Message['endsReply']
    }
  | { ref: Message; json: string }
type ActivityEntry =
  | {
      ref: Activity
      json?: undefined
      id: string
      label: string
      summary: Activity['summary']
      title: Activity['title']
      startedAt: Activity['startedAt']
      todo: Activity['todo']
      browser: Activity['browser']
      detail: Activity['detail']
      output: Activity['output']
      status: Activity['status']
      agent: Activity['agent']
    }
  | { ref: Activity; json: string }

const hasNestedMessage = (m: Message) =>
  Boolean(m.blocks || m.todos || m.attachments || m.report || m.turn || m.handoff)
const samePlainMessage = (a: Extract<MessageEntry, { json?: undefined }>, b: Message) =>
  !hasNestedMessage(b) &&
  a.id === b.id &&
  a.role === b.role &&
  a.text === b.text &&
  a.createdAt === b.createdAt &&
  a.queued === b.queued &&
  a.unsent === b.unsent &&
  a.rewindFailed === b.rewindFailed &&
  a.answered === b.answered &&
  a.provider === b.provider &&
  a.endsReply === b.endsReply
const samePlainActivity = (a: Extract<ActivityEntry, { json?: undefined }>, b: Activity) =>
  !b.compact &&
  a.id === b.id &&
  a.label === b.label &&
  a.summary === b.summary &&
  a.title === b.title &&
  a.startedAt === b.startedAt &&
  a.todo === b.todo &&
  a.browser === b.browser &&
  a.detail === b.detail &&
  a.output === b.output &&
  a.status === b.status &&
  a.agent === b.agent

// What one tab was last sent, for the next diff.
export class ThreadDiff {
  private started = false
  private id: string | undefined
  private rest = ''
  private messages: MessageEntry[] = []
  private activities: ActivityEntry[] = []
  // Messages as last sent, by index, for appends: their shape and text. Only messages that
  // changed are kept (in practice the one streaming).
  private sentMessages = new Map<number, { shape: string; text: string }>()
  // stringify: how messages and steps are serialized; the server shares one cache between tabs
  // within an update, so each message is serialized once, not once per tab.
  // append: send messages that only grew as appends (the tab asked for them).
  constructor(
    private stringify: (value: object) => string = JSON.stringify,
    private append = false,
  ) {}

  private snapMessage(m: Message): MessageEntry {
    if (hasNestedMessage(m)) return { ref: m, json: this.stringify(m) }
    return {
      ref: m,
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
      queued: m.queued,
      unsent: m.unsent,
      rewindFailed: m.rewindFailed,
      answered: m.answered,
      provider: m.provider,
      endsReply: m.endsReply,
    }
  }
  private snapActivity(a: Activity): ActivityEntry {
    if (a.compact) return { ref: a, json: this.stringify(a) }
    return {
      ref: a,
      id: a.id,
      label: a.label,
      summary: a.summary,
      title: a.title,
      startedAt: a.startedAt,
      todo: a.todo,
      browser: a.browser,
      detail: a.detail,
      output: a.output,
      status: a.status,
      agent: a.agent,
    }
  }

  // What to send this time: the whole thread (first time, or another thread), a patch, or
  // nothing when nothing changed.
  next(
    thread: Thread | null,
  ): { thread: Thread | null } | { threadPatch: ThreadPatch } | undefined {
    if (!thread) {
      const send = !this.started || this.id !== undefined
      this.started = true
      this.id = undefined
      return send ? { thread: null } : undefined
    }
    const { messages, activities, ...rest } = thread
    const restJson = JSON.stringify(rest)
    if (!this.started || this.id !== thread.id) {
      this.started = true
      this.id = thread.id
      this.rest = restJson
      this.messages = messages.map((item) => this.snapMessage(item))
      this.activities = activities.map((item) => this.snapActivity(item))
      this.sentMessages.clear()
      return { thread }
    }
    const patch: ThreadPatch = { id: thread.id }
    if (restJson !== this.rest) {
      this.rest = restJson
      patch.rest = rest
    }
    const messagesPatch = this.diffMessages(messages)
    if (messagesPatch && this.append) this.appends(messages, messagesPatch)
    if (messagesPatch) patch.messages = messagesPatch
    const activitiesPatch = this.diffActivities(activities)
    if (activitiesPatch) patch.activities = activitiesPatch
    return patch.rest || patch.messages || patch.activities ? { threadPatch: patch } : undefined
  }

  private diffMessages(items: Message[]): ListPatch<Message> | undefined {
    const previous = this.messages
    const changed: [number, Message][] = []
    const next: MessageEntry[] = new Array(items.length)
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!
      const prev = previous[index]
      if (prev) {
        if (prev.json === undefined) {
          if (prev.ref === item) {
            if (samePlainMessage(prev, item)) {
              next[index] = prev
              continue
            }
            changed.push([index, item])
            next[index] = this.snapMessage(item)
            continue
          }
          if (this.stringify(prev.ref) === this.stringify(item)) {
            next[index] = this.snapMessage(item)
            continue
          }
        } else if (this.stringify(item) === prev.json) {
          next[index] = prev
          continue
        }
      }
      changed.push([index, item])
      next[index] = this.snapMessage(item)
    }
    this.messages = next
    return changed.length || items.length !== previous.length
      ? { count: items.length, changed }
      : undefined
  }

  private diffActivities(items: Activity[]): ListPatch<Activity> | undefined {
    const previous = this.activities
    const changed: [number, Activity][] = []
    const next: ActivityEntry[] = new Array(items.length)
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!
      const prev = previous[index]
      if (prev) {
        if (prev.json === undefined) {
          if (prev.ref === item) {
            if (samePlainActivity(prev, item)) {
              next[index] = prev
              continue
            }
            changed.push([index, item])
            next[index] = this.snapActivity(item)
            continue
          }
          if (this.stringify(prev.ref) === this.stringify(item)) {
            next[index] = this.snapActivity(item)
            continue
          }
        } else if (this.stringify(item) === prev.json) {
          next[index] = prev
          continue
        }
      }
      changed.push([index, item])
      next[index] = this.snapActivity(item)
    }
    this.activities = next
    return changed.length || items.length !== previous.length
      ? { count: items.length, changed }
      : undefined
  }

  // Changed messages that only grew since they were last sent go as appends instead of whole.
  // A message's first change goes whole; after that it's compared with what was sent.
  private appends(messages: Message[], patch: MessagesPatch) {
    for (const index of this.sentMessages.keys())
      if (index >= messages.length) this.sentMessages.delete(index)
    const changed: [number, Message][] = []
    const appended: [number, number, string][] = []
    for (const entry of patch.changed) {
      const [index, message] = entry
      const text = message.text ?? ''
      const shape = shapeOf(message)
      const sent = this.sentMessages.get(index)
      if (sent && sent.shape === shape && text.startsWith(sent.text))
        appended.push([index, sent.text.length, text.slice(sent.text.length)])
      else changed.push(entry)
      this.sentMessages.set(index, { shape, text })
    }
    patch.changed = changed
    if (appended.length) patch.appended = appended
  }
}

const applyList = <T>(previous: T[], patch: ListPatch<T> | undefined) => {
  if (!patch) return previous
  const next = previous.slice(0, patch.count)
  for (const [index, item] of patch.changed) next[index] = item
  return next
}

// The thread after a patch (unchanged messages and steps stay the same objects), or null when
// it doesn't fit this copy (an append to text of another length): get the thread whole again.
export function applyThreadPatch(base: Thread, patch: ThreadPatch): Thread | null {
  const { messages, activities, ...rest } = base
  const nextMessages = applyList(messages, patch.messages)
  for (const [index, from, text] of patch.messages?.appended ?? []) {
    const message = nextMessages[index]
    if (!message || (message.text ?? '').length !== from) return null
    nextMessages[index] = { ...message, text: (message.text ?? '') + text }
  }
  return {
    ...(patch.rest ?? rest),
    messages: nextMessages,
    activities: applyList(activities, patch.activities),
  } as Thread
}
