import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DelegationBlock } from '../blocks'
import type { Activity, Thread } from '../types'
import {
  changedBetween,
  changedFiles,
  delegationBrief,
  findDelegationCard,
  folderState,
  ownChanges,
  stopLeftoverCards,
} from './delegations'
import { AgentService } from './service'
import { ThreadStore } from './store'
import type { ProviderContext, Runner } from './providers/types'

describe('sub-agent helpers', () => {
  it('reads the files a run changed from its Edit and Write steps', () => {
    const steps: Activity[] = [
      { id: '1', label: 'Read', summary: 'src/a.ts', status: 'completed' },
      { id: '2', label: 'Edit', summary: 'src/a.ts', status: 'completed' },
      { id: '3', label: 'Write', summary: 'src/new.ts', status: 'completed' },
      { id: '4', label: 'Edit', summary: 'src/b.ts, src/c.ts +2 more', status: 'completed' },
    ]
    expect(changedFiles(steps)).toEqual(['src/a.ts', 'src/new.ts', 'src/b.ts', 'src/c.ts'])
  })

  it('finds files changed in a git folder between two looks, shell commands included', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const repo = await mkdtemp(join(tmpdir(), 't3-mini-folder-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args])
    git('init', '-q')
    await writeFile(join(repo, 'a.txt'), 'a')
    await writeFile(join(repo, 'dirty.txt'), 'x')
    const before = await folderState(repo)
    // A new file and a change to one that was already changed.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(join(repo, 'new.txt'), 'n')
    await writeFile(join(repo, 'dirty.txt'), 'xy')
    const changed = changedBetween(before, await folderState(repo))
    expect(changed.sort()).toEqual(['dirty.txt', 'new.txt'])
    expect(await folderState(tmpdir())).toBeNull()
    await rm(repo, { recursive: true, force: true })
  })

  it('credits only files its own steps mention when others may have worked meanwhile', () => {
    const steps: Activity[] = [
      { id: '1', label: 'Run', summary: "printf 'hi' > hello.txt", status: 'completed' },
    ]
    expect(ownChanges(['hello.txt', 'bye.txt'], steps, false)).toEqual(['hello.txt'])
    expect(ownChanges(['hello.txt', 'bye.txt'], steps, true)).toEqual(['hello.txt', 'bye.txt'])
  })

  it('briefs a sub-agent on who it works for, its access, and files to avoid', () => {
    const brief = delegationBrief({
      lead: { id: 'lead-1', title: 'Checkout' },
      task: 'Write the tests',
      access: 'read-only',
      folder: '/tmp/app',
      recap: '[For context…]',
      busyFiles: ['src/cart.ts'],
    })
    expect(brief).toContain('sub-agent of the t3 mini thread "Checkout"')
    expect(brief).toContain('read-only')
    expect(brief).toContain('src/cart.ts')
    expect(brief).toContain('[For context…]')
    expect(brief.endsWith('Task:\nWrite the tests')).toBe(true)
  })

  it('stops cards left running by a restart', () => {
    const card: DelegationBlock = {
      type: 'delegation',
      id: 'd1',
      title: 'Tests',
      agent: 'claude',
      access: 'edit',
      background: true,
      status: 'running',
      step: 'Run tests',
      startedAt: '2026-01-01T00:00:00.000Z',
    }
    const thread = {
      messages: [{ id: 'm', role: 'assistant', text: '', createdAt: '', blocks: [card] }],
    } as unknown as Thread
    expect(stopLeftoverCards(thread, '2026-01-01T00:01:00.000Z')).toBe(true)
    expect(findDelegationCard(thread.messages, 'd1')?.block).toMatchObject({
      status: 'stopped',
      endedAt: '2026-01-01T00:01:00.000Z',
    })
    expect(findDelegationCard(thread.messages, 'd1')?.block.step).toBeUndefined()
  })
})

describe('sub-agents (delegate_task)', () => {
  let directory: string
  let service: AgentService
  // Each turn of each thread waits until the test ends it with a reply.
  type Turn = { ctx: ProviderContext; end: (reply: string) => void }
  let turns: Map<string, Turn[]>
  const until = async <T>(check: () => T, ms = 10_000): Promise<NonNullable<T>> => {
    for (const start = Date.now(); Date.now() - start < ms;) {
      const value = check()
      if (value) return value as NonNullable<T>
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('Timed out waiting.')
  }
  const runner: Runner = (ctx) =>
    new Promise<void>((resolve) => {
      ctx.session(ctx.thread.sessionId ?? `session-${ctx.thread.id}`)
      const list = turns.get(ctx.thread.id) ?? []
      list.push({
        ctx,
        end: (reply) => {
          ctx.text(crypto.randomUUID(), reply)
          resolve()
        },
      })
      turns.set(ctx.thread.id, list)
      ctx.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  const turnCount = (id: string) => turns.get(id)?.length ?? 0
  const nextTurn = (id: string, after = turnCount(id)) => until(() => turns.get(id)?.[after])
  const card = (lead: Thread, id: string) => findDelegationCard(lead.messages, id)?.block
  // A lead's sub-agents, by their cards, oldest first.
  const delegateIds = (lead: Thread) =>
    lead.messages.flatMap((message) =>
      (message.blocks ?? []).flatMap((block) => (block.type === 'delegation' ? [block.id] : [])),
    )
  // Its newest one (not one of `known`).
  const newestDelegate = (lead: Thread, known: string[] = []) =>
    until(() =>
      delegateIds(lead)
        .filter((id) => !known.includes(id))
        .at(-1),
    )

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 't3-mini-delegate-'))
    turns = new Map()
    service = new AgentService(new ThreadStore(join(directory, 'threads.json')), {
      claude: runner,
      codex: runner,
    })
  })
  afterEach(async () => {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('waits for a sub-agent and returns its answer and the files it changed', async () => {
    const lead = await service.create({ provider: 'claude', cwd: directory })
    await service.send(lead.id, { text: 'Build the checkout page' })
    const leadTurn = await nextTurn(lead.id, 0)
    const result = leadTurn.ctx.tools.delegates.start({ task: 'Write the tests', title: 'Tests' })
    const id = await newestDelegate(lead)
    const delegate = service.get(id)
    // A hidden thread working in the lead's folder, on the same agent, with the brief and recap.
    expect(delegate).toMatchObject({
      delegateOf: lead.id,
      workIn: lead.cwd,
      provider: 'claude',
      title: 'Tests',
      delegate: { access: 'edit', background: false },
    })
    expect(service.list().map((item) => item.id)).toEqual([lead.id])
    const work = await nextTurn(id, 0)
    expect(work.ctx.cwd).toBe(lead.cwd)
    expect(work.ctx.prompt).toContain('sub-agent of the t3 mini thread')
    expect(work.ctx.prompt).toContain('Build the checkout page')
    expect(work.ctx.prompt).toContain('Task:\nWrite the tests')
    // No nesting.
    await expect(work.ctx.tools.delegates.start({ task: 'More' })).rejects.toThrow(
      /can’t start sub-agents/,
    )
    // Its progress shows on the card as it works.
    work.ctx.activity({ id: 'e1', label: 'Edit', summary: 'src/cart.test.ts', status: 'running' })
    await until(() => card(lead, id)?.step === 'Edit src/cart.test.ts')
    work.ctx.activity({ id: 'e1', label: 'Edit', status: 'completed' })
    work.end('Wrote 4 tests for the cart.')
    const text = await result
    expect(text).toContain('Sub-agent "Tests"')
    expect(text).toContain('finished')
    expect(text).toContain('src/cart.test.ts')
    expect(text).toContain('Wrote 4 tests for the cart.')
    expect(card(lead, id)).toMatchObject({
      status: 'done',
      files: ['src/cart.test.ts'],
      answer: 'Wrote 4 tests for the cart.',
    })
    leadTurn.end('Done.')
  })

  it('runs sub-agents in the background; each reports back, and a follow-up keeps its memory', async () => {
    const lead = await service.create({ provider: 'claude', cwd: directory })
    await service.send(lead.id, { text: 'Split it up' })
    const leadTurn = await nextTurn(lead.id, 0)
    const started = await leadTurn.ctx.tools.delegates.start({
      task: 'Research the API',
      title: 'Research',
      agent: 'codex',
      wait: false,
      access: 'read-only',
    })
    expect(started).toContain('in the background')
    const id = await newestDelegate(lead)
    expect(service.get(id)).toMatchObject({ provider: 'codex', delegate: { access: 'read-only' } })
    const research = await nextTurn(id, 0)
    // The lead ends its turn; it still shows as working while its sub-agent does.
    leadTurn.end('Started research.')
    await until(() => lead.status === 'completed')
    expect(service.list()[0]).toMatchObject({ id: lead.id, status: 'working' })
    // The sub-agent finishing wakes the lead with a report.
    research.end('The API pages results with a cursor.')
    const woken = await nextTurn(lead.id, 1)
    expect(woken.ctx.prompt).toContain('[Report from sub-agent "Research"')
    expect(woken.ctx.prompt).toContain('pages results with a cursor')
    expect(lead.messages.find((message) => message.report)?.report).toMatchObject({
      delegate: true,
      threadId: id,
      status: 'completed',
    })
    // A follow-up goes to the same sub-agent, resuming its session.
    const followUp = woken.ctx.tools.delegates.start({
      task: 'Now check rate limits',
      continue: id,
    })
    const second = await nextTurn(id, 1)
    expect(second.ctx.thread.sessionId).toBe(`session-${id}`)
    expect(second.ctx.prompt).toBe('Now check rate limits')
    second.end('100 requests a minute.')
    expect(await followUp).toContain('100 requests a minute.')
    expect(woken.ctx.tools.delegates.list()).toContain('"Research"')
    woken.end('Noted.')
  })

  it('stops a sub-agent without a report, and limits how many run at once', async () => {
    const lead = await service.create({ provider: 'claude', cwd: directory })
    await service.send(lead.id, { text: 'Go' })
    const leadTurn = await nextTurn(lead.id, 0)
    const control = leadTurn.ctx.tools.delegates
    const ids: string[] = []
    for (let index = 0; index < 5; index++) {
      await control.start({ task: `Part ${index}`, wait: false })
      ids.push(await newestDelegate(lead, ids))
    }
    await expect(control.start({ task: 'One more', wait: false })).rejects.toThrow(/5 sub-agents/)
    await nextTurn(ids[0]!, 0)
    expect(await control.stop(ids[0]!)).toContain('Stopped')
    await until(() => card(lead, ids[0]!)?.status === 'stopped')
    // Not one of its own.
    await expect(control.stop(lead.id)).rejects.toThrow(/isn’t one of your sub-agents/)
    leadTurn.end('Working on it.')
    await until(() => lead.status === 'completed')
    // A stop isn't reported.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lead.messages.some((message) => message.report)).toBe(false)
    for (const id of ids.slice(1)) await service.stop(id)
  })

  it('flags files two sub-agents both changed, and surfaces a waiting sub-agent in the lead', async () => {
    const lead = await service.create({ provider: 'claude', cwd: directory })
    await service.send(lead.id, { text: 'Go' })
    const leadTurn = await nextTurn(lead.id, 0)
    const control = leadTurn.ctx.tools.delegates
    await control.start({ task: 'Header', wait: false })
    const first = await newestDelegate(lead)
    const firstTurn = await nextTurn(first, 0)
    firstTurn.ctx.activity({
      id: 'a',
      label: 'Edit',
      summary: 'src/layout.tsx',
      status: 'completed',
    })
    await until(() => card(lead, first)?.files?.length)
    await control.start({ task: 'Footer', wait: false })
    const second = await newestDelegate(lead, [first])
    const secondTurn = await nextTurn(second, 0)
    // The newcomer is told what the other one has changed.
    expect(secondTurn.ctx.prompt).toContain('src/layout.tsx')
    secondTurn.ctx.activity({
      id: 'b',
      label: 'Edit',
      summary: 'src/layout.tsx',
      status: 'completed',
    })
    await until(() => card(lead, second)?.overlaps?.length)
    // Waiting on the user: the card says so and the lead shows as waiting.
    const approval = secondTurn.ctx.approve({ id: 'ok', title: 'Run npm test?', detail: '' })
    await until(() => card(lead, second)?.status === 'waiting')
    expect(card(lead, second)?.step).toBe('Waiting for you: Run npm test?')
    expect(service.list()[0]).toMatchObject({ status: 'waiting', waitingFor: 'approval' })
    service.approve(second, 'ok', true)
    expect(await approval).toBe(true)
    firstTurn.end('Header done.')
    secondTurn.end('Footer done.')
    leadTurn.end('Both started.')
    await until(() => lead.messages.filter((message) => message.report).length >= 1)
  })

  it('deletes its sub-agents along with the lead', async () => {
    const lead = await service.create({ provider: 'claude', cwd: directory })
    await service.send(lead.id, { text: 'Go' })
    const leadTurn = await nextTurn(lead.id, 0)
    await leadTurn.ctx.tools.delegates.start({ task: 'Long job', wait: false })
    const id = await newestDelegate(lead)
    await nextTurn(id, 0)
    leadTurn.end('Started.')
    await until(() => lead.status === 'completed')
    await service.remove(lead.id)
    expect(() => service.get(id)).toThrow('Thread not found')
  })
})
