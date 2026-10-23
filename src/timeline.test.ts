import { describe, expect, it } from 'vitest'
import { buildTurns, finishLabel, foldLabel, liveNote, noteLine, type WorkItem } from './timeline'
import type { Activity, Message } from './types'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 9, 0, seconds)).toISOString()
const user = (id: string, s: number, extra: Partial<Message> = {}): Message => ({
  id,
  role: 'user',
  text: id,
  createdAt: at(s),
  ...extra,
})
const reply = (id: string, s: number, text = id): Message => ({
  id,
  role: 'assistant',
  text,
  createdAt: at(s),
})
const step = (id: string, s?: number, status: Activity['status'] = 'completed'): Activity => ({
  id,
  label: 'Run',
  status,
  ...(s === undefined ? {} : { startedAt: at(s) }),
})
const kinds = (work: ReturnType<typeof buildTurns>[number]['work']) =>
  work.map((item) =>
    item.kind === 'note'
      ? item.message.id
      : item.kind === 'todos'
        ? 'todos'
        : `step:${item.activity.id}`,
  )

describe('buildTurns', () => {
  it('folds a finished turn: notes and steps in order, the last reply as the answer', () => {
    const [first, second] = buildTurns({
      messages: [
        user('q1', 0),
        reply('a1', 5),
        user('q2', 10),
        reply('n1', 12),
        reply('n2', 20),
        reply('final', 40),
      ],
      activities: [step('s1', 11), step('s2', 15), step('s3', 30)],
      status: 'completed',
      completedAt: at(45),
    })
    expect(first).toMatchObject({ key: 'q1', done: true, steps: 0, work: [] })
    expect(first!.answer?.id).toBe('a1')
    expect(second!.answer?.id).toBe('final')
    expect(kinds(second!.work)).toEqual(['step:s1', 'n1', 'step:s2', 'n2', 'step:s3'])
    expect(foldLabel(second!, 'completed')).toBe('Worked for 35s · 3 steps')
    // Older turns have no saved steps; they count messages instead.
    expect(
      foldLabel({ ...first!, work: [{ kind: 'note', message: reply('x', 1), at: at(1) }] }),
    ).toBe('Worked for 5s · 1 message')
    // A turn that compacted the conversation says so (its divider is inside the fold).
    const compacted = { ...step('c1', 20), label: 'Compact', compact: { before: 9, after: 2 } }
    expect(
      foldLabel(
        {
          ...second!,
          work: [...second!.work, { kind: 'step', activity: compacted, at: at(20) }],
        },
        'completed',
      ),
    ).toBe('Worked for 35s · 3 steps · compacted')
  })

  it('shows a turn in progress live, with no answer picked yet', () => {
    const turns = buildTurns({
      messages: [user('q', 0), reply('n1', 3), reply('n2', 8)],
      activities: [step('s1', 5), step('s2', 9, 'running')],
      status: 'working',
    })
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ done: false, steps: 2 })
    expect(turns[0]!.answer).toBeUndefined()
    expect(kinds(turns[0]!.work)).toEqual(['n1', 'step:s1', 'n2', 'step:s2'])
  })

  it('keeps the running turn live while a queued message waits', () => {
    const turns = buildTurns({
      messages: [user('q', 0), reply('n1', 3), user('later', 4, { queued: true })],
      activities: [step('s1', 5, 'running')],
      status: 'working',
    })
    expect(turns.map((turn) => [turn.key, turn.done])).toEqual([
      ['q', false],
      ['later', false],
    ])
    // The step started after the queued message, but it belongs to the running turn.
    expect([turns[0]!.steps, turns[1]!.steps]).toEqual([1, 0])
  })

  it('puts steps saved without a time after the current turn’s notes', () => {
    const [turn] = buildTurns({
      messages: [user('q', 0), reply('n1', 3), reply('final', 8)],
      activities: [step('old1'), step('old2')],
      status: 'completed',
      completedAt: at(9),
    })
    expect(turn!.answer?.id).toBe('final')
    expect(kinds(turn!.work)).toEqual(['n1', 'step:old1', 'step:old2'])
  })

  it('moves images from folded notes onto the final answer', () => {
    const image = (id: string) => ({ type: 'image' as const, id })
    const [turn] = buildTurns({
      messages: [
        user('q', 0),
        { ...reply('n1', 3), blocks: [image('one'), image('two')] },
        reply('n2', 5),
        { ...reply('final', 9), blocks: [image('three')] },
      ],
      activities: [],
      status: 'completed',
      completedAt: at(10),
    })
    expect(turn!.answer?.id).toBe('final')
    expect(turn!.blocks.map((block) => (block.type === 'image' ? block.id : block.type))).toEqual([
      'one',
      'two',
    ])
    // While the turn runs, images stay where they are.
    const [live] = buildTurns({
      messages: [user('q', 0), { ...reply('n1', 3), blocks: [image('one')] }],
      activities: [],
      status: 'working',
    })
    expect(live!.blocks).toEqual([])
  })

  it('draws to-do updates as one checklist card where the list first appeared', () => {
    const todo = (id: string, s: number): Activity => ({ ...step(id, s), todo: true })
    const [turn] = buildTurns({
      messages: [user('q', 0), reply('n1', 2), reply('final', 20)],
      activities: [todo('t1', 3), step('s1', 5), todo('t2', 8), step('s2', 10)],
      todos: [{ id: '1', text: 'Step', status: 'completed' }],
      status: 'completed',
      completedAt: at(21),
    })
    expect(kinds(turn!.work)).toEqual(['n1', 'todos', 'step:s1', 'step:s2'])
    expect(turn!.steps).toBe(2)
  })

  it('gives each turn its own checklist: saved ones for older turns, the live one for this run', () => {
    const list = (done: number, total: number) =>
      Array.from({ length: total }, (_, index) => ({
        id: String(index + 1),
        text: `Item ${index + 1}`,
        status: index < done ? ('completed' as const) : ('pending' as const),
      }))
    const todo = (id: string, s: number): Activity => ({ ...step(id, s), todo: true })
    const [first, second, third] = buildTurns({
      messages: [
        user('q1', 0, { todos: list(2, 2) }),
        reply('a1', 10),
        user('q2', 20),
        reply('a2', 30),
        user('q3', 40),
        reply('n3', 42),
      ],
      activities: [todo('t3', 41), step('s3', 43, 'running')],
      todos: list(1, 3),
      status: 'working',
    })
    // The first turn's steps are gone, but its own list comes back as a card.
    expect(kinds(first!.work)).toEqual(['todos'])
    expect(first!.todos).toEqual(list(2, 2))
    // A turn that kept no list shows none, even though the thread has a live one.
    expect(second!.todos).toBeUndefined()
    expect(kinds(second!.work)).toEqual([])
    // The running turn shows the live list.
    expect(third!.todos).toEqual(list(1, 3))
    expect(kinds(third!.work)).toEqual(['todos', 'n3', 'step:s3'])
  })

  it('keeps a running turn’s status cards in view, and moves them to the answer when done', () => {
    const card = {
      type: 'status' as const,
      id: 'deploy',
      kind: 'deploy' as const,
      status: 'running' as const,
      title: 'Deploying',
      startedAt: at(2),
    }
    const note = { ...reply('n1', 2), blocks: [card] }
    const [live] = buildTurns({ messages: [user('q', 0), note], activities: [], status: 'working' })
    expect(live!.cards).toEqual([card])
    const [done] = buildTurns({
      messages: [user('q', 0), note, reply('final', 9)],
      activities: [],
      status: 'completed',
      completedAt: at(10),
    })
    expect(done!.cards).toEqual([])
    expect(done!.blocks).toEqual([card])
  })

  it('never shows a live list in a turn that did not write one', () => {
    const [turn] = buildTurns({
      messages: [user('q', 0), reply('a', 5)],
      activities: [step('s1', 2)],
      todos: [{ id: '1', text: 'Old item', status: 'in_progress' }],
      status: 'completed',
      completedAt: at(6),
    })
    expect(turn!.todos).toBeUndefined()
    expect(kinds(turn!.work)).toEqual(['step:s1'])
  })

  it('says when a run stopped or failed', () => {
    const [turn] = buildTurns({
      messages: [user('q', 0), reply('n1', 3), reply('partial', 70)],
      activities: [step('s1', 5, 'failed')],
      status: 'interrupted',
      completedAt: at(75),
    })
    expect(foldLabel(turn!, 'interrupted')).toBe('Stopped after 1m 15s · 1 step')
    expect(foldLabel(turn!, 'failed')).toBe('Failed after 1m 15s · 1 step')
  })

  it('says how much of the checklist was left when a turn ended unfinished', () => {
    const todos = [
      { id: '1', text: 'One', status: 'completed' as const },
      { id: '2', text: 'Two', status: 'in_progress' as const },
      { id: '3', text: 'Three', status: 'pending' as const },
    ]
    const [turn] = buildTurns({
      messages: [user('q', 0, { todos }), reply('n1', 3), reply('partial', 70)],
      activities: [step('s1', 5), { ...step('t1', 4), todo: true }],
      status: 'interrupted',
      completedAt: at(75),
    })
    expect(foldLabel(turn!, 'interrupted')).toBe('Stopped after 1m 15s · 1 step · 2 of 3 left')
    const finished = {
      ...turn!,
      todos: todos.map((todo) => ({ ...todo, status: 'completed' as const })),
    }
    expect(foldLabel(finished, 'completed')).toBe('Worked for 1m 15s · 1 step')
  })
})

describe('replies that ended a response', () => {
  it('stay in view, in order, when the turn folds; only the work before them folds', () => {
    const [turn] = buildTurns({
      messages: [
        user('q', 0),
        reply('note', 2),
        { ...reply('summary', 5), endsReply: true },
        { ...reply('followup', 9), endsReply: true },
      ],
      activities: [],
      status: 'completed',
      completedAt: at(10),
    })
    expect(turn!.answer?.id).toBe('followup')
    expect(turn!.replies.map((message) => message.id)).toEqual(['summary'])
    expect(turn!.work.map((item) => (item.kind === 'note' ? item.message.id : item.kind))).toEqual([
      'note',
    ])
  })
  it('a turn with one answer works as before', () => {
    const [turn] = buildTurns({
      messages: [user('q', 0), reply('note', 2), { ...reply('final', 5), endsReply: true }],
      activities: [],
      status: 'completed',
      completedAt: at(6),
    })
    expect(turn!.answer?.id).toBe('final')
    expect(turn!.replies).toEqual([])
  })
  it('keeps every note live while the turn is still running', () => {
    const [turn] = buildTurns({
      messages: [user('q', 0), { ...reply('summary', 5), endsReply: true }],
      activities: [],
      status: 'working',
    })
    expect(turn!.replies).toEqual([])
    expect(turn!.work).toHaveLength(1)
  })
})

describe('finishLabel', () => {
  const turn = (seconds: number, endedAt = '2026-10-19T06:00:00.000Z') =>
    ({
      startedAt: new Date(Date.parse(endedAt) - seconds * 1000).toISOString(),
      endedAt,
    }) as Parameters<typeof finishLabel>[0]
  const sameDay = new Date('2026-10-19T06:30:00.000Z')
  const clock = new Date('2026-10-19T06:00:00.000Z').toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })

  it('says how long the turn took and when it finished', () => {
    expect(finishLabel(turn(24), 'completed', sameDay)).toBe(`Worked for 24s · done ${clock}`)
    expect(finishLabel(turn(130), 'completed', sameDay)).toBe(`Worked for 2m 10s · done ${clock}`)
    expect(finishLabel(turn(3900), 'completed', sameDay)).toBe(`Worked for 1h 5m · done ${clock}`)
  })
  it('says when it was stopped or failed', () => {
    expect(finishLabel(turn(12), 'interrupted', sameDay)).toBe(`Stopped after 12s · ${clock}`)
    expect(finishLabel(turn(12), 'failed', sameDay)).toBe(`Failed after 12s · ${clock}`)
  })
  it('adds the date when it ended on another day', () => {
    const later = new Date('2026-10-22T06:00:00.000Z')
    expect(finishLabel(turn(24), 'completed', later)).toMatch(/^Worked for 24s · done .+, .+$/)
  })
  it('needs both times', () => {
    expect(finishLabel({ endedAt: undefined } as never, 'completed')).toBeUndefined()
  })
})

it('turns the agent’s latest note into one plain line for the working line', () => {
  expect(
    noteLine(
      'Court cards look normal.\n\nThe browser clicks keep landing on the **wrong buttons**, so I’ll use the `local API`:',
    ),
  ).toBe('The browser clicks keep landing on the wrong buttons, so I’ll use the local API:')
  expect(noteLine('Next:\n\n- check the [standings](http://localhost:3000)\n- report back')).toBe(
    'check the standings report back',
  )
  expect(noteLine('Here it is:\n\n```ts\nconst x = 1\n```')).toBe('Here it is:')
  expect(noteLine('   ')).toBe('')
})

describe('liveNote', () => {
  const note = (text: string): WorkItem => ({
    kind: 'note',
    message: { id: text, role: 'assistant', text, createdAt: '' },
    at: '',
  })
  const step: WorkItem = { kind: 'step', activity: { id: 's' } as never, at: '' }

  it('waits for a streaming note to finish a paragraph', () => {
    expect(liveNote([note('Checking the build and')])).toBeUndefined()
    expect(liveNote([note('Checking the build and the tests.\n\nThen I')])).toBe(
      'Checking the build and the tests.',
    )
  })
  it('shows the whole note once something comes after it', () => {
    expect(liveNote([note('Running the tests now'), step])).toBe('Running the tests now')
  })
  it('keeps the previous note while the next one streams', () => {
    expect(liveNote([note('Build passed.'), step, note('Now the')])).toBe('Build passed.')
  })
  it('never shows the inside of an unfinished code block', () => {
    expect(liveNote([note('Here:\n\n```ts\nconst a = 1\n\nconst b')])).toBe('Here:')
  })
})
