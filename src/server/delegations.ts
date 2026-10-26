import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DelegationBlock } from '../blocks'
import type { Activity, Message, Thread } from '../types'

// Sub-agents (delegate_task): another agent, Claude or Codex, working on a task for a thread
// (its lead) in the lead's folder. Each is a thread of its own that isn't listed in the sidebar
// (Thread.delegateOf), so it gets everything a thread has: both agents' runners, steps, to-dos,
// approvals, a session for follow-ups, saving, and a page with its full log. The lead shows it
// as a card (DelegationBlock) in the reply that started it, updated in place as it works. The
// service (AgentService.delegateControl) starts, waits for, stops, and reports on them; this
// file holds the parts that don't need the service. See docs/delegation.md.

export const maxRunningDelegates = 5
// What the lead gets back: the sub-agent's final answer, up to this much.
export const maxAnswer = 12_000
// The card keeps a shorter copy.
const maxCardAnswer = 1_500

const names = { claude: 'Claude', codex: 'Codex' } as const
export const agentLabel = (agent: 'claude' | 'codex') => names[agent]

// The sub-agent's first message: who it works for, how it may work, what others are touching,
// what the conversation is about (optional), then the task.
export function delegationBrief(input: {
  lead: Pick<Thread, 'title' | 'id'>
  task: string
  access: 'read-only' | 'edit'
  folder: string
  recap?: string
  busyFiles?: string[]
}) {
  const rules = [
    `[You are a sub-agent of the t3 mini thread "${input.lead.title}" (id ${input.lead.id}). ` +
      'Your final answer goes back to that thread, so end with a clear summary of what you ' +
      'found or did (and the files you changed).',
    `You work in ${input.folder}, the same folder as that thread and any other sub-agents.`,
    input.access === 'read-only'
      ? 'This task is read-only: look, run any checks or commands you need, and report; don’t ' +
        'change files.'
      : 'Other agents may be editing this folder at the same time: change only the files your ' +
        'task needs, and don’t revert or reformat changes you didn’t make.',
    ...(input.busyFiles?.length
      ? [
          `Other sub-agents running now have changed: ${input.busyFiles.slice(0, 30).join(', ')}. ` +
            'Avoid editing those unless your task requires it.',
        ]
      : []),
    'You can’t start sub-agents or helper threads of your own.]',
  ]
  return [rules.join('\n'), input.recap ?? '', `Task:\n${input.task}`].filter(Boolean).join('\n\n')
}

// Files a run changed, from its Edit and Write steps (Codex lists several as "a, b +2 more").
export function changedFiles(activities: Activity[]) {
  const files = new Set<string>()
  for (const step of activities) {
    if ((step.label !== 'Edit' && step.label !== 'Write') || !step.summary) continue
    for (const part of step.summary.split(', ')) {
      const file = part.replace(/ \+\d+ more$/, '').trim()
      if (file) files.add(file)
    }
  }
  return [...files]
}

// A git folder's changed files with their state (status and modified time), to see which ones
// a sub-agent changed between its start and its end, including through shell commands
// (`printf > file`), which its Edit/Write steps don't show. Null outside git. Capped, so a
// huge working tree can't slow a run down.
const run = promisify(execFile)
export async function folderState(folder: string): Promise<Map<string, string> | null> {
  let stdout: string
  try {
    ;({ stdout } = await run(
      'git',
      ['-C', folder, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
    ))
  } catch {
    return null
  }
  const root = (
    await run('git', ['-C', folder, 'rev-parse', '--show-toplevel'], { timeout: 5000 }).catch(
      () => ({ stdout: folder }),
    )
  ).stdout.trim()
  const entries = stdout.split('\0').filter(Boolean)
  const state = new Map<string, string>()
  for (let index = 0; index < entries.length && state.size < 2000; index++) {
    const entry = entries[index]!
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    // A rename or copy is followed by its old path.
    if (/[RC]/.test(code)) index++
    const info = await stat(join(root, path)).catch(() => null)
    state.set(path, `${code}:${info ? info.mtimeMs : 'gone'}`)
  }
  return state
}
// Files whose state changed between two looks (new changes, or changed again).
export function changedBetween(
  before: Map<string, string> | null,
  after: Map<string, string> | null,
) {
  if (!before || !after) return []
  return [...after].filter(([path, value]) => before.get(path) !== value).map(([path]) => path)
}

// Which of the folder's changes were this sub-agent's. When nothing else could have touched the
// folder meanwhile (it ran alone and its lead waited), all of them; otherwise only the files its
// own steps mention (a command or edit naming the file).
export function ownChanges(changed: string[], activities: Activity[], alone: boolean): string[] {
  if (alone) return changed
  const said = activities
    .map((step) => [step.title, step.summary, step.detail].filter(Boolean).join(' '))
    .join('\n')
  return changed.filter((path) => said.includes(path.split('/').pop()!))
}

// What the sub-agent is doing right now, for its card: the running step, else its latest one.
export function currentStep(thread: Pick<Thread, 'activities' | 'approvals'>) {
  if (thread.approvals[0]) return `Waiting for you: ${thread.approvals[0].title}`
  const steps = thread.activities.filter((step) => !step.todo && !step.compact)
  const step = [...steps].reverse().find((item) => item.status === 'running') ?? steps.at(-1)
  if (!step) return undefined
  const text = step.title ?? [step.label, step.summary].filter(Boolean).join(' ')
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

// The sub-agent's latest reply (its answer once the run ends).
export function lastReply(thread: Pick<Thread, 'messages'>) {
  return [...thread.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.text.trim())?.text
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text

// The card for a sub-agent as its thread stands now, keeping what the previous card knew (files
// from earlier runs, its start time).
export function delegationCard(
  thread: Thread,
  previous: DelegationBlock,
  overlapsWith: (files: string[]) => string[],
  now: string,
): DelegationBlock {
  const running =
    thread.status === 'starting' || thread.status === 'working' || thread.status === 'waiting'
  const files = [...new Set([...(previous.files ?? []), ...changedFiles(thread.activities)])]
  const overlaps = overlapsWith(files)
  const todos = thread.todos?.length
    ? {
        done: thread.todos.filter((todo) => todo.status === 'completed').length,
        total: thread.todos.length,
      }
    : undefined
  const status: DelegationBlock['status'] = running
    ? thread.status === 'waiting'
      ? 'waiting'
      : 'running'
    : thread.status === 'failed'
      ? 'failed'
      : thread.status === 'interrupted'
        ? 'stopped'
        : 'done'
  const reply = running ? undefined : lastReply(thread)
  const {
    step: _step,
    todos: _todos,
    files: _files,
    overlaps: _overlaps,
    answer: _answer,
    error: _error,
    endedAt: _endedAt,
    ...kept
  } = previous
  const step = running ? currentStep(thread) : undefined
  return {
    ...kept,
    status,
    ...(step ? { step } : {}),
    ...(todos ? { todos } : {}),
    ...(files.length ? { files } : {}),
    ...(overlaps.length ? { overlaps } : {}),
    ...(reply ? { answer: clip(reply, maxCardAnswer) } : {}),
    ...(status === 'failed' && thread.error ? { error: thread.error } : {}),
    ...(running ? {} : { endedAt: previous.endedAt ?? now }),
  }
}

// The latest card for this sub-agent in the lead's messages (a follow-up adds a newer one).
export function findDelegationCard(messages: Message[], id: string) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    for (const block of message.blocks ?? [])
      if (block.type === 'delegation' && block.id === id) return { message, block }
  }
  return undefined
}

// Replaces the card in place (a new object, so live updates see the change). False when the
// card is gone (e.g. its reply was edited away) or nothing changed.
export function replaceDelegationCard(messages: Message[], next: DelegationBlock) {
  const found = findDelegationCard(messages, next.id)
  if (!found || JSON.stringify(found.block) === JSON.stringify(next)) return false
  found.message.blocks = found.message.blocks!.map((item) => (item === found.block ? next : item))
  return true
}

// After a restart nothing is running any more: cards still marked running or waiting are
// stopped (their sub-agents' threads are marked interrupted the same way).
export function stopLeftoverCards(thread: Thread, now: string) {
  let changed = false
  for (const message of thread.messages) {
    if (!message.blocks?.some((block) => block.type === 'delegation')) continue
    message.blocks = message.blocks.map((block) => {
      if (block.type !== 'delegation' || (block.status !== 'running' && block.status !== 'waiting'))
        return block
      changed = true
      const { step: _step, ...rest } = block
      return { ...rest, status: 'stopped', endedAt: block.endedAt ?? now }
    })
  }
  return changed
}

// What the lead gets when the sub-agent's run ends: the tool result (waiting) or the report
// message (background).
export function delegationResult(thread: Thread, card: DelegationBlock) {
  const who = `Sub-agent "${card.title}" (id ${thread.id}, ${agentLabel(card.agent)})`
  const files = card.files?.length
    ? `Files it changed: ${card.files.join(', ')}.`
    : card.access === 'edit'
      ? 'It changed no files.'
      : ''
  const overlaps = card.overlaps?.length
    ? `Also changed by another sub-agent: ${card.overlaps.join(', ')}. Check those for conflicts.`
    : ''
  const reply = lastReply(thread)
  const headline =
    card.status === 'done'
      ? 'finished'
      : card.status === 'failed'
        ? `failed: ${thread.error ?? 'unknown error'}`
        : card.status === 'waiting'
          ? `is waiting for the user: ${thread.approvals[0]?.title ?? 'an approval'}. They can answer on its card.`
          : 'was stopped'
  const answer =
    card.status === 'waiting'
      ? ''
      : reply
        ? `${card.status === 'done' ? 'Its answer' : 'Its last reply'}:\n${clip(reply, maxAnswer)}`
        : card.status === 'done'
          ? '(It finished without a reply.)'
          : ''
  const details = [files, overlaps, answer].filter(Boolean).join('\n\n')
  return {
    details,
    // The tool result, when the lead waited for it.
    text: [`${who} ${headline}.`, details].filter(Boolean).join('\n\n'),
    // The message, when it ran in the background (shown as a report card).
    report: `[Report from ${who.charAt(0).toLowerCase()}${who.slice(1)}: ${headline}.]${details ? `\n\n${details}` : ''}`,
  }
}
