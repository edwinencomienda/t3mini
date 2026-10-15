import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentService } from './service'
import { ThreadStore } from './store'
import type { ProviderContext, Runner, Steer } from './providers/types'

let directory: string
let service: AgentService
let context: ProviderContext
let finish: () => void
let reject: (error: Error) => void
let started: Promise<void>
let markStarted: () => void
// Set by a test to make the fake provider accept mid-turn messages.
let steerHandler: Steer | undefined
const runner: Runner = async (ctx) => {
  context = ctx
  if (steerHandler) ctx.onSteer?.(steerHandler)
  ctx.session('native-session')
  markStarted()
  await new Promise<void>((resolve, fail) => {
    finish = resolve
    reject = fail
    ctx.signal.addEventListener('abort', () => fail(new Error('Stopped')), { once: true })
  })
}
beforeEach(async () => {
  steerHandler = undefined
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
  it('streams a turn and keeps the provider session identity', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Build this' })
    await started
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
it('saves image uploads by content type, rejects disguised files, and passes images to the agent', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
  const image = await service.upload({
    kind: 'image',
    name: 'shot.png',
    mimeType: 'image/png',
    data: png.toString('base64'),
  })
  expect(image).toMatchObject({ kind: 'image', mimeType: 'image/png' })
  if (image.kind !== 'image') throw new Error('expected an image')
  await expect(
    service.upload({
      kind: 'image',
      name: 'evil.png',
      mimeType: 'image/png',
      data: Buffer.from('<svg onload=alert(1)>').toString('base64'),
    }),
  ).rejects.toThrow('Only PNG')
  const file = await service.upload({
    kind: 'file',
    name: '../../notes report.txt',
    data: Buffer.from('hello').toString('base64'),
  })
  if (file.kind !== 'file') throw new Error('expected a file')
  expect(file.path.startsWith(join(directory, 'attachments', 'files'))).toBe(true)
  expect(file.path.endsWith('notes_report.txt')).toBe(true)
  expect(await readFile(file.path, 'utf8')).toBe('hello')

  const created = await thread()
  await service.send(created.id, { text: '', attachments: [{ id: image.id, name: 'shot.png' }] })
  await started
  expect(context.images).toEqual([
    { path: join(directory, 'attachments', image.id), mimeType: 'image/png' },
  ])
  expect(service.get(created.id).messages[0]?.attachments?.[0]?.id).toBe(image.id)
  await expect(
    service.send(created.id, { text: 'hi', attachments: [{ id: '../threads.json', name: 'x' }] }),
  ).rejects.toThrow()
})
it('orders threads by your last message, not by streaming agent activity', async () => {
  const first = await thread()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await thread()
  expect(service.list().map((item) => item.id)).toEqual([second.id, first.id])
  await new Promise((resolve) => setTimeout(resolve, 5))
  await service.send(first.id, { text: 'Work on this' })
  await started
  expect(service.list().map((item) => item.id)).toEqual([first.id, second.id])
  // The other thread getting newer activity must not move it above the one you messaged.
  await new Promise((resolve) => setTimeout(resolve, 5))
  service.get(second.id).updatedAt = new Date().toISOString()
  context.text('reply', 'streaming text')
  expect(service.list().map((item) => item.id)).toEqual([first.id, second.id])
})
it('reports uncommitted tracked and untracked changes in the thread project', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { writeFile } = await import('node:fs/promises')
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: directory })
  const created = await thread()
  expect((await service.diff(created.id)).repo).toBe(false)
  await git('init', '-q')
  await writeFile(join(directory, 'tracked.txt'), 'one\ntwo\n')
  await git('add', 'tracked.txt')
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init')
  await writeFile(join(directory, 'tracked.txt'), 'one\n2\n')
  await writeFile(join(directory, '-new.txt'), 'fresh\n')
  const diff = await service.diff(created.id)
  const summary = diff.files.map((file) => [file.path, file.status, file.additions, file.deletions])
  expect(summary).toContainEqual(['tracked.txt', 'modified', 1, 1])
  expect(summary).toContainEqual(['-new.txt', 'added', 1, 0])
})
it('changes the diff fingerprint when files change, and only then', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { writeFile, utimes } = await import('node:fs/promises')
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: directory })
  const created = await thread()
  expect((await service.diffVersion(created.id)).version).toBeNull()
  await git('init', '-q')
  await writeFile(join(directory, 'a.txt'), 'one\n')
  await git('add', 'a.txt')
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init')
  await writeFile(join(directory, 'a.txt'), 'two\n')
  const first = (await service.diffVersion(created.id)).version
  expect(first).toBeTruthy()
  expect((await service.diffVersion(created.id)).version).toBe(first)
  // Editing an already-modified file keeps the same git status, but must still be detected.
  await writeFile(join(directory, 'a.txt'), 'three!\n')
  await utimes(join(directory, 'a.txt'), new Date(), new Date(Date.now() + 5_000))
  const second = (await service.diffVersion(created.id)).version
  expect(second).not.toBe(first)
  await writeFile(join(directory, 'b.txt'), 'new\n')
  expect((await service.diffVersion(created.id)).version).not.toBe(second)
})
it('caps the changes panel at 200 files and hides the lines of huge files', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { writeFile, mkdir } = await import('node:fs/promises')
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: directory })
  const created = await thread()
  await git('init', '-q')
  await mkdir(join(directory, 'many'))
  await Promise.all(
    Array.from({ length: 230 }, (_, index) =>
      writeFile(join(directory, 'many', `f${index}.txt`), `${index}\n`),
    ),
  )
  await writeFile(join(directory, 'huge.txt'), 'line\n'.repeat(3500))
  const diff = await service.diff(created.id)
  expect(diff.files).toHaveLength(200)
  expect(diff.totalFiles).toBeGreaterThanOrEqual(231)
  expect(diff.truncated).toBe(true)
  await git('add', 'huge.txt')
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init')
  await writeFile(join(directory, 'huge.txt'), 'changed\n'.repeat(3500))
  const huge = (await service.diff(created.id)).files.find((file) => file.path === 'huge.txt')
  expect(huge).toMatchObject({ tooLarge: true, additions: 3500, deletions: 3500, hunks: [] })
})

describe('sending while the agent works', () => {
  const nextStart = () =>
    (started = new Promise((resolve) => {
      markStarted = resolve
    }))
  it('hands the message to the live run when the provider supports steering', async () => {
    const steered: string[] = []
    steerHandler = async ({ prompt }) => {
      steered.push(prompt)
      return true
    }
    const created = await thread()
    await service.send(created.id, { text: 'Build this' })
    await started
    expect(await service.send(created.id, { text: 'Use TypeScript' })).toEqual({
      accepted: true,
      steered: true,
    })
    expect(steered).toEqual(['Use TypeScript'])
    expect(created.messages.at(-1)).toMatchObject({ role: 'user', text: 'Use TypeScript' })
    expect(created.messages.at(-1)?.queued).toBeUndefined()
    await settle(created.id, finish)
    expect(created.status).toBe('completed')
  })
  it('queues the message and runs it as the next turn when steering is unavailable', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Build this' })
    await started
    expect(await service.send(created.id, { text: 'Then add tests' })).toEqual({
      accepted: true,
      steered: false,
    })
    expect(created.messages.at(-1)?.queued).toBe(true)
    const second = nextStart()
    finish()
    await second
    expect(context.prompt).toBe('Then add tests')
    expect(
      created.messages.find((message) => message.text === 'Then add tests')?.queued,
    ).toBeUndefined()
    expect(created.status).not.toBe('completed')
    await settle(created.id, finish)
    expect(created.status).toBe('completed')
  })
  it('keeps queued messages but does not send them when the turn is stopped', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Build this' })
    await started
    await service.send(created.id, { text: 'Never mind, also this' })
    await service.stop(created.id)
    expect(created.status).toBe('interrupted')
    const message = created.messages.find((item) => item.text === 'Never mind, also this')
    expect(message).toMatchObject({ unsent: true })
    expect(message?.queued).toBeUndefined()
  })
})
describe('stopping and restarting with messages sent mid-turn', () => {
  it('never starts a new turn when a steer fails because the turn was stopped', async () => {
    let release!: (taken: boolean) => void
    steerHandler = () =>
      new Promise<boolean>((resolve) => {
        release = resolve
      })
    const created = await thread()
    await service.send(created.id, { text: 'Build this' })
    await started
    const steering = service.send(created.id, { text: 'Also this' })
    // Stop only once the steer is in flight with the provider.
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
    await service.stop(created.id)
    release(false)
    await steering
    expect(created.status).toBe('interrupted')
    expect(created.messages.find((item) => item.text === 'Also this')).toMatchObject({
      unsent: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(created.status).toBe('interrupted')
  })
  it('marks messages still queued at a restart as not sent', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Build this' })
    await started
    await service.send(created.id, { text: 'Queued before restart' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(directory, 'restart.json'), JSON.stringify([service.get(created.id)]))
    const store = new ThreadStore(join(directory, 'restart.json'))
    await store.load()
    const message = store.threads
      .get(created.id)
      ?.messages.find((item) => item.text === 'Queued before restart')
    expect(message).toMatchObject({ unsent: true })
    expect(message?.queued).toBeUndefined()
  })
})
