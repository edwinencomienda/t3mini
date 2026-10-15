import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentService } from './service'
import { ThreadStore } from './store'
import type { ProviderContext, Runner } from './providers/types'

let directory: string
let service: AgentService
let context: ProviderContext
let finish: () => void
let reject: (error: Error) => void
let started: Promise<void>
let markStarted: () => void
const runner: Runner = async (ctx) => {
  context = ctx
  ctx.session('native-session')
  markStarted()
  await new Promise<void>((resolve, fail) => {
    finish = resolve
    reject = fail
    ctx.signal.addEventListener('abort', () => fail(new Error('Stopped')), { once: true })
  })
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-test-'))
  started = new Promise((resolve) => {
    markStarted = resolve
  })
  service = new AgentService(new ThreadStore(join(directory, 'threads.json')), {
    codex: runner,
    claude: runner,
  })
})
afterEach(async () => {
  await service.close()
  await rm(directory, { recursive: true, force: true })
})
async function thread() {
  return service.create({ provider: 'codex', cwd: directory })
}
async function settle(id: string, action: () => void) {
  const settled = new Promise<void>((resolve) => {
    const unsubscribe = service.subscribe(() => {
      if (!['starting', 'working', 'waiting'].includes(service.get(id).status)) {
        unsubscribe()
        resolve()
      }
    })
  })
  action()
  await settled
}
describe('agent lifecycle', () => {
  it('creates and persists threads with a validated project folder', async () => {
    const created = await thread()
    expect(JSON.parse(await readFile(join(directory, 'threads.json'), 'utf8'))[0].id).toBe(
      created.id,
    )
    await expect(
      service.create({ provider: 'codex', cwd: join(directory, 'missing') }),
    ).rejects.toThrow('does not exist')
  })
  it('rejects concurrent turns and resumes provider session identity', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Build this' })
    await started
    await expect(service.send(created.id, { text: 'Another' })).rejects.toThrow('already working')
    expect(context.thread.sessionId).toBe('native-session')
    context.text('answer', 'Hello ')
    context.text('answer', 'world')
    context.text('answer', 'Hello world', true)
    await settle(created.id, finish)
    expect(created.status).toBe('completed')
    expect(created.messages.at(-1)?.text).toBe('Hello world')
    expect(created.completedAt).toBeTruthy()
  })
  it('waits for explicit approval, then returns to working', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Run a tool' })
    await started
    const permission = context.approve({ id: 'tool', title: 'Run command?', detail: 'git status' })
    expect(created.status).toBe('waiting')
    service.approve(created.id, 'tool', false)
    expect(await permission).toBe(false)
    expect(created.status).toBe('working')
    expect(created.approvals).toEqual([])
    expect(() => service.approve(created.id, 'tool', true)).toThrow('no longer pending')
  })
  it('stops a waiting turn, resolves permission, and can delete it', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Work' })
    await started
    const permission = context.approve({ id: 'tool', title: 'Run?', detail: 'command' })
    await expect(service.remove(created.id)).rejects.toThrow('Stop the agent')
    await service.stop(created.id)
    expect(await permission).toBe(false)
    expect(created.status).toBe('interrupted')
    await service.remove(created.id)
    expect(service.list()).toEqual([])
  })
  it('marks a provider error as failed, never completed', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Work' })
    await started
    await settle(created.id, () => reject(new Error('Provider disconnected')))
    expect(created.status).toBe('failed')
    expect(created.error).toBe('Provider disconnected')
  })
  it('recovers active persisted threads as interrupted after restart', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Work' })
    await started
    await service.store.save()
    const recovered = new ThreadStore(join(directory, 'threads.json'))
    await recovered.load()
    expect(recovered.threads.get(created.id)?.status).toBe('interrupted')
    expect(recovered.threads.get(created.id)?.sessionId).toBe('native-session')
  })
})

it('saves thread settings and supplies them to the next provider run', async () => {
  const created = await thread()
  const settings = { model: 'custom-model', effort: '', permissionMode: 'full-access' }
  await service.updateSettings(created.id, settings)
  const saved = JSON.parse(await readFile(join(directory, 'threads.json'), 'utf8'))[0]
  expect(saved).toMatchObject(settings)
  await service.send(created.id, { text: 'Use these settings' })
  await started
  expect(context.thread).toMatchObject(settings)
  await expect(
    service.updateSettings(created.id, { ...settings, permissionMode: 'approval-required' }),
  ).rejects.toThrow('current operation')
  expect(context.thread.permissionMode).toBe('full-access')
})
it('rejects invalid permission modes and efforts without a selected model', async () => {
  const created = await thread()
  await expect(
    service.updateSettings(created.id, { model: '', effort: '', permissionMode: 'whatever' }),
  ).rejects.toThrow()
  await expect(
    service.updateSettings(created.id, {
      model: '',
      effort: 'high',
      permissionMode: 'approval-required',
    }),
  ).rejects.toThrow('Choose a model')
  expect(created.effort).toBe('')
})
it('migrates old saved conversations without dropping their history or provider session', async () => {
  const created = await thread()
  const legacy: Partial<typeof created> = { ...created, sessionId: 'existing-session' }
  delete legacy.effort
  delete legacy.permissionMode
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(directory, 'legacy.json'), JSON.stringify([legacy]))
  const store = new ThreadStore(join(directory, 'legacy.json'))
  await store.load()
  expect(store.threads.get(created.id)).toMatchObject({
    effort: '',
    permissionMode: 'auto-accept-edits',
    sessionId: 'existing-session',
    messages: [],
  })
})
it('starts new threads with full access unless a permission mode is chosen', async () => {
  expect((await thread()).permissionMode).toBe('full-access')
  const claude = await service.create({ provider: 'claude', cwd: directory })
  expect(claude.permissionMode).toBe('full-access')
  const restricted = await service.create({
    provider: 'claude',
    cwd: directory,
    permissionMode: 'approval-required',
  })
  expect(restricted.permissionMode).toBe('approval-required')
})
it('renames a thread, trims the title, and rejects empty names', async () => {
  const created = await thread()
  const renamed = await service.rename(created.id, { title: '  Release prep  ' })
  expect(renamed.title).toBe('Release prep')
  const saved = JSON.parse(await readFile(join(directory, 'threads.json'), 'utf8'))
  expect(saved.find((item: { id: string }) => item.id === created.id).title).toBe('Release prep')
  await expect(service.rename(created.id, { title: '   ' })).rejects.toThrow()
  await service.send(created.id, { text: 'This should not replace a custom title' })
  expect(service.get(created.id).title).toBe('Release prep')
})
it('saves projects, lists them by recent activity, and only removes empty ones', async () => {
  const { mkdir, realpath } = await import('node:fs/promises')
  await mkdir(join(directory, 'other-project'))
  // The server stores resolved paths (on macOS, /var resolves to /private/var).
  const other = await realpath(join(directory, 'other-project'))
  const created = await thread()
  // Make the added project strictly newer than the thread so the order is deterministic.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const added = await service.addProject({ path: other })
  expect(added).toMatchObject({ path: other, threadCount: 0 })
  expect(service.projects().map((project) => project.path)).toEqual([other, created.cwd])
  const saved = JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8'))
  expect(saved.map((project: { path: string }) => project.path).sort()).toEqual(
    [created.cwd, other].sort(),
  )
  await expect(service.addProject({ path: join(directory, 'missing') })).rejects.toThrow(
    'does not exist',
  )
  await expect(service.removeProject({ path: created.cwd })).rejects.toThrow('threads')
  await service.removeProject({ path: other })
  expect(service.projects().map((project) => project.path)).toEqual([created.cwd])
})
it('switches agents only before the first message', async () => {
  const created = await thread()
  const switched = await service.updateSettings(created.id, {
    provider: 'claude',
    model: '',
    effort: '',
    permissionMode: 'full-access',
  })
  expect(switched.provider).toBe('claude')
  await service.send(created.id, { text: 'Hello' })
  await started
  finish()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await expect(
    service.updateSettings(created.id, {
      provider: 'codex',
      model: '',
      effort: '',
      permissionMode: 'full-access',
    }),
  ).rejects.toThrow('new thread')
  expect(service.get(created.id).provider).toBe('claude')
})
it('reports the git branch of a thread project, or none outside a repository', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const created = await thread()
  expect(await service.gitInfo(created.id)).toEqual({ branch: null })
  const git = promisify(execFile)
  await git('git', ['-C', created.cwd, 'init', '-q', '-b', 'feature/test-branch'])
  expect(await service.gitInfo(created.id)).toEqual({ branch: 'feature/test-branch' })
})
