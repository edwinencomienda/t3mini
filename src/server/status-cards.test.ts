import { expect, it } from 'vitest'
import { newStatusBlock, stopRunningCards, turnStatusCards, updateStatusCard } from './status-cards'
import type { StatusBlock } from '../blocks'
import type { Message } from '../types'
import type { StatusCard } from './tools/types'

const t0 = '2026-10-24T10:00:00.000Z'
const t1 = '2026-10-24T10:01:12.000Z'
const card = (extra: Partial<StatusCard> = {}): StatusCard => ({
  id: 'deploy',
  kind: 'deploy',
  status: 'running',
  title: 'Deploying',
  ...extra,
})
const reply = (id: string, blocks: StatusBlock[] = []): Message => ({
  id,
  role: 'assistant',
  text: '',
  createdAt: t0,
  blocks,
})
const user = (id: string): Message => ({ id, role: 'user', text: id, createdAt: t0 })
const status = (messages: Message[]) => turnStatusCards(messages, -1).map(({ block }) => block)

it('updates the card in place, keeping fields left out and the start time', () => {
  const messages = [
    user('q'),
    reply('a', [newStatusBlock(card({ stages: ['Build', 'Live'], stage: 'Build' }), t0)]),
  ]
  expect(
    updateStatusCard(
      messages,
      0,
      card({ status: 'done', stage: 'Live', url: 'https://x.dev/' }),
      t1,
    ),
  ).toBe(true)
  expect(status(messages)).toEqual([
    {
      type: 'status',
      id: 'deploy',
      kind: 'deploy',
      status: 'done',
      title: 'Deploying',
      stages: ['Build', 'Live'],
      stage: 'Live',
      url: 'https://x.dev/',
      startedAt: t0,
      endedAt: t1,
    },
  ])
})

it("only updates this turn's card, so a reused id in a new turn gets its own", () => {
  const messages = [user('q1'), reply('a1', [newStatusBlock(card(), t0)]), user('q2'), reply('a2')]
  expect(updateStatusCard(messages, 2, card({ status: 'done' }), t1)).toBe(false)
  expect(status(messages)[0]!.status).toBe('running')
})

it('marks cards still running as not finished when the turn ends', () => {
  const done = newStatusBlock(card({ id: 'push', kind: 'push', status: 'done' }), t0)
  const messages = [user('q'), reply('a', [newStatusBlock(card(), t0), done])]
  stopRunningCards(messages, 0, t1)
  const [deploy, push] = messages[1]!.blocks as StatusBlock[]
  expect(deploy).toMatchObject({ status: 'stopped', endedAt: t1 })
  expect(push).toBe(done)
})
