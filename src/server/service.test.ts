import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './service'
import { ProjectStore, ThreadStore } from './store'
import type { TitleWriter } from './titles'
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
  it('marks each reply the agent ended a response with, in this turn only', async () => {
    const created = await thread()
    await service.send(created.id, { text: 'Fix it and run the suite in the background' })
    await started
    context.text('note', 'Working on it')
    context.text('summary', 'Fixed. The full suite is still running.')
    context.replied?.()
    // Background work finished: Claude wakes up and adds a follow-up.
    context.text('followup', 'The full suite passed.')
    context.replied?.()
    context.replied?.()
    await settle(created.id, finish)
    const flags = created.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.text, Boolean(message.endsReply)])
    expect(flags).toEqual([
      ['Working on it', false],
      ['Fixed. The full suite is still running.', true],
      ['The full suite passed.', true],
    ])
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
it('lets the agent rename only its own thread through the rename tool', async () => {
  const created = await thread()
  const other = await thread()
  await service.send(created.id, { text: 'Name this thread' })
  await started
  expect(await context.tools.rename('Login bug')).toBe('Login bug')
  expect(service.get(created.id).title).toBe('Login bug')
  expect(service.get(other.id).title).toBe('New thread')
  const saved = JSON.parse(await readFile(join(directory, 'threads.json'), 'utf8'))
  expect(saved.find((item: { id: string }) => item.id === created.id).title).toBe('Login bug')
  await settle(created.id, () => finish())
})
it('takes dictation vocabulary from the last two agent replies only', async () => {
  const created = await thread()
  created.messages.push(
    { id: 'a1', role: 'assistant', text: 'Old reply about Kubernetes.', createdAt: '' },
    { id: 'u1', role: 'user', text: 'My message mentions Zanzibarqux.', createdAt: '' },
    { id: 'a2', role: 'assistant', text: 'Then we used Deepgram here.', createdAt: '' },
    { id: 'a3', role: 'assistant', text: 'And Vite restarted.', createdAt: '' },
  )
  const terms = await service.dictationKeyterms(created.id)
  expect(terms).toEqual(expect.arrayContaining(['Deepgram', 'Vite']))
  expect(terms).not.toContain('Kubernetes')
  expect(terms).not.toContain('Zanzibarqux')
  expect(await service.dictationKeyterms('no-such-thread')).toEqual([])
})
it('waits on agent questions like approvals and returns your answers', async () => {
  const created = await thread()
  await service.send(created.id, { text: 'Fix the login' })
  await started
  const questions = [{ question: 'Block 2FA users?', options: [{ label: 'Yes' }, { label: 'No' }] }]
  const answered = context.ask!({ id: 'q1', title: 'Claude has a question', questions })
  expect(created.status).toBe('waiting')
  expect(created.approvals).toEqual([
    { id: 'q1', title: 'Claude has a question', detail: '', questions },
  ])
  service.approve(created.id, 'q1', true, { 'Block 2FA users?': 'Yes' })
  expect(await answered).toEqual({ 'Block 2FA users?': 'Yes' })
  expect(created.status).toBe('working')
  // Skipping resolves with no answers.
  const skipped = context.ask!({ id: 'q2', title: 'Claude has a question', questions })
  service.approve(created.id, 'q2', false)
  expect(await skipped).toBeNull()
  // Background tasks show while the turn is open and clear when it ends.
  context.background!([{ id: 'task-1', description: 'Update docs' }])
  expect(created.background).toEqual([{ id: 'task-1', description: 'Update docs' }])
  await settle(created.id, finish)
  expect(created.background).toBeUndefined()
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
it('creates a missing project folder when asked, only inside the home folder', async () => {
  const { realpath, stat } = await import('node:fs/promises')
  // A stand-in home folder, so the test never touches the real one.
  const home = await realpath(directory)
  vi.stubEnv('HOME', home)
  try {
    // Not created without asking.
    await expect(service.addProject({ path: '~/code/new-app' })).rejects.toThrow('does not exist')
    const added = await service.addProject({ path: '~/code/new-app', create: true })
    expect(added.path).toBe(join(home, 'code', 'new-app'))
    expect((await stat(added.path)).isDirectory()).toBe(true)
    // An existing folder is fine with create too.
    await expect(service.addProject({ path: '~/code/new-app', create: true })).resolves.toBeTruthy()
    // Never outside home, even through `..`.
    for (const path of ['/tmp/t3-mini-outside-home', '~/../outside-home'])
      await expect(service.addProject({ path, create: true })).rejects.toThrow(
        'inside your home folder',
      )
  } finally {
    vi.unstubAllEnvs()
  }
})
it('gives a short glance at a thread for the sidebar hover card', async () => {
  const created = await thread()
  expect(service.glance(created.id)).toMatchObject({ id: created.id, messageCount: 0 })
  expect(service.glance(created.id).lastMessage).toBeUndefined()
  await service.send(created.id, { text: `Start   here ${'x'.repeat(300)}` })
  await started
  context.text('reply', 'All done.', true)
  await settle(created.id, finish)
  const glance = service.glance(created.id)
  expect(glance.messageCount).toBe(2)
  expect(glance.lastMessage).toMatch(/^Start here x+…$/)
  expect(glance.lastMessage!.length).toBe(160)
  expect(glance.lastReply).toBe('All done.')
  expect(glance).not.toHaveProperty('messages')
  expect(() => service.glance('missing')).toThrow('Thread not found')
})
it('searches conversations for the command palette, one excerpt per thread', async () => {
  const created = await thread()
  await service.send(created.id, { text: 'Please fix the   Flaky login test in CI' })
  await started
  await settle(created.id, finish)
  await thread()
  const [match, ...rest] = service.searchMessages('flaky LOGIN')
  expect(rest).toEqual([])
  expect(match).toMatchObject({ threadId: created.id, cwd: created.cwd, role: 'user' })
  // Which message it was found in, so opening the result can scroll to it.
  expect(match!.messageId).toBe(service.get(created.id).messages[0]!.id)
  // Whitespace is collapsed, and long text is cut around the match.
  expect(match!.snippet).toBe('Please fix the Flaky login test in CI')
  expect(service.searchMessages('nothing like this')).toEqual([])
  expect(() => service.searchMessages('a')).toThrow()
  expect(() => service.searchMessages('x'.repeat(201))).toThrow()
})
it('narrows the sidebar search as you type, and sees new messages', async () => {
  const first = await thread()
  await service.send(first.id, { text: 'Deploy (the) app.example.com [staging]' })
  await started
  await settle(first.id, finish)
  // Regex characters are matched literally.
  expect(service.searchMessages('(the) app.example', 500).map((match) => match.threadId)).toEqual([
    first.id,
  ])
  expect(service.searchMessages('[staging]').map((match) => match.threadId)).toEqual([first.id])
  expect(service.searchMessages('the app')).toEqual([])
  // A longer query reuses the shorter one's threads; a change in between rescans them all.
  expect(service.searchMessages('depl').map((match) => match.threadId)).toEqual([first.id])
  const second = await thread()
  await service.send(second.id, { text: 'Deploy the docs' })
  await settle(second.id, finish)
  expect(
    service
      .searchMessages('deploy')
      .map((match) => match.threadId)
      .sort(),
  ).toEqual([first.id, second.id].sort())
  expect(service.searchMessages('deploy', 1)).toHaveLength(1)
  // A bad limit falls back to the default.
  expect(service.searchMessages('deploy', 'lots')).toHaveLength(2)
})
it('keeps a project’s place in the sidebar after its threads are deleted', async () => {
  const { mkdir, realpath } = await import('node:fs/promises')
  await mkdir(join(directory, 'older'))
  await mkdir(join(directory, 'newer'))
  const older = await realpath(join(directory, 'older'))
  const newer = await realpath(join(directory, 'newer'))
  await service.addProject({ path: older })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await service.addProject({ path: newer })
  // Working in the older project moves it to the top…
  await new Promise((resolve) => setTimeout(resolve, 5))
  const created = await service.create({ provider: 'codex', cwd: older })
  await service.send(created.id, { text: 'Hello' })
  await started
  await settle(created.id, finish)
  expect(service.projects().map((project) => project.path)).toEqual([older, newer])
  // …and deleting its only thread doesn't send it back down, even after a restart.
  await service.remove(created.id)
  expect(service.projects().map((project) => project.path)).toEqual([older, newer])
  const store = new ProjectStore(join(directory, 'projects.json'))
  await store.load()
  expect(store.projects.get(older)?.lastActiveAt).toBeTruthy()
})
it('answers a waiting question with the message you send instead of picking', async () => {
  const created = await thread()
  await service.send(created.id, { text: 'Build it' })
  await started
  const asked = context.ask!({
    id: 'question-1',
    title: 'Claude has a question',
    questions: [
      { question: 'Which footer?', options: [{ label: 'One row' }, { label: 'Two columns' }] },
    ],
  })
  expect(service.get(created.id).status).toBe('waiting')
  // Sending a message answers it, as "Something else".
  expect(await service.send(created.id, { text: '  Neither, keep the old one  ' })).toMatchObject({
    answered: true,
  })
  expect(await asked).toEqual({ 'Which footer?': 'Neither, keep the old one' })
  const current = service.get(created.id)
  expect(current.status).toBe('working')
  expect(current.approvals).toEqual([])
  expect(current.messages.at(-1)).toMatchObject({
    role: 'user',
    text: 'Neither, keep the old one',
    answered: true,
  })
  await settle(created.id, finish)
})
it('shares the sidebar Group by setting across every browser, and keeps it', async () => {
  expect(service.snapshot().ui).toEqual({ groupBy: 'project' })
  let updates = 0
  const unsubscribe = service.subscribe(() => updates++)
  expect(await service.updateUi({ groupBy: 'none' })).toEqual({ groupBy: 'none' })
  unsubscribe()
  // Every open window hears about it, and it's in the next snapshot.
  expect(updates).toBeGreaterThan(0)
  expect(service.snapshot().ui).toEqual({ groupBy: 'none' })
  // Saved, so a restart keeps it.
  const { UiStore, uiStorePath } = await import('./store')
  const store = new UiStore(uiStorePath(join(directory, 'threads.json')))
  await store.load()
  expect(store.settings).toEqual({ groupBy: 'none' })
  expect(await service.updateUi({ groupBy: 'date' })).toEqual({ groupBy: 'date' })
  await expect(service.updateUi({ groupBy: 'sideways' })).rejects.toThrow()
  await expect(service.updateUi({ fontSize: 40 })).rejects.toThrow()
})
it('shares view settings across browsers, checks them, and keeps the music spot quiet', async () => {
  let updates = 0
  const unsubscribe = service.subscribe(() => updates++)
  await service.updateUi({
    theme: 'dark',
    projectIcons: false,
    animations: true,
    collapsed: { '/work/app': true },
    music: { enabled: true, url: 'https://youtu.be/jfKfPfyJRdk', volume: 30 },
    agent: {
      provider: 'codex',
      settings: { codex: { model: 'gpt-6-luna', effort: 'high', permissionMode: 'full-access' } },
    },
  })
  expect(updates).toBe(1)
  // The music's spot is saved often, so on its own it isn't broadcast.
  await service.updateUi({ musicPosition: { source: 'jfKfPfyJRdk:', time: 42 } })
  expect(updates).toBe(1)
  unsubscribe()
  expect(service.snapshot().ui).toMatchObject({
    groupBy: 'project',
    theme: 'dark',
    projectIcons: false,
    musicPosition: { time: 42 },
  })
  for (const bad of [
    { theme: 'neon' },
    { music: { enabled: true, url: 'x', volume: 400 } },
    { agent: { settings: { codex: { model: 'x', effort: 'y', permissionMode: 'root' } } } },
    { collapsed: { a: 'yes' } },
  ])
    await expect(service.updateUi(bad), JSON.stringify(bad)).rejects.toThrow()
  // A damaged file keeps the good fields and drops the rest.
  const { readUiSettings } = await import('./ui-settings')
  expect(readUiSettings({ theme: 'light', projectIcons: 'nope', groupBy: 'sideways' })).toEqual({
    groupBy: 'project',
    theme: 'light',
  })
})
it('marks a finished thread unread for every device, unless you are watching it', async () => {
  // Nobody looking: it finishes unread, in the shared thread list.
  const first = await thread()
  await service.send(first.id, { text: 'Go' })
  await started
  await settle(first.id, finish)
  expect(service.list().find((item) => item.id === first.id)?.unread).toBe(true)
  // Opening it anywhere clears it for everyone.
  await service.markRead(first.id)
  expect(service.list().find((item) => item.id === first.id)?.unread).toBeUndefined()
  // A tab showing it, with you looking: it finishes read.
  started = new Promise((resolve) => (markStarted = resolve))
  service.tabs.report('tab-on-phone', 'visit', Date.now(), { viewing: first.id, watching: true })
  await service.send(first.id, { text: 'Again' })
  await started
  await settle(first.id, finish)
  expect(service.get(first.id).unread).toBeUndefined()
  // The tab is open but you've switched away: unread again.
  started = new Promise((resolve) => (markStarted = resolve))
  service.tabs.report('tab-on-phone', 'alive', Date.now(), { viewing: first.id, watching: false })
  await service.send(first.id, { text: 'Once more' })
  await started
  await settle(first.id, finish)
  expect(service.get(first.id).unread).toBe(true)
})
it('renames a project label without touching its folder, and resets it with an empty name', async () => {
  const created = await thread()
  const renamed = await service.renameProject({ path: created.cwd, name: '  Client site  ' })
  expect(renamed).toMatchObject({ path: created.cwd, name: 'Client site', threadCount: 1 })
  expect(service.get(created.id).cwd).toBe(created.cwd)
  // The name survives a restart.
  const store = new ProjectStore(join(directory, 'projects.json'))
  await store.load()
  expect(store.projects.get(created.cwd)?.name).toBe('Client site')
  const reset = await service.renameProject({ path: created.cwd, name: '' })
  expect(reset.name).toBeUndefined()
  await expect(
    service.renameProject({ path: join(directory, 'unknown'), name: 'Nope' }),
  ).rejects.toThrow('Project not found')
  await expect(service.renameProject({ path: created.cwd, name: 'x'.repeat(81) })).rejects.toThrow()
})
it('sets a project avatar: letter, an uploaded image, or back to automatic', async () => {
  const created = await thread()
  const path = created.cwd
  expect(await service.setProjectAvatar({ path, avatar: 'letter' })).toMatchObject({
    avatar: 'letter',
  })
  // An image must be an existing upload, named by its id (never a path).
  await expect(service.setProjectAvatar({ path, avatar: 'image' })).rejects.toThrow(
    'Choose an image first',
  )
  await expect(
    service.setProjectAvatar({ path, avatar: 'image', image: '../projects.json' }),
  ).rejects.toThrow('Choose an image first')
  await expect(
    service.setProjectAvatar({
      path,
      avatar: 'image',
      image: '00000000-0000-0000-0000-000000000000.png',
    }),
  ).rejects.toThrow('missing')
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const upload = await service.upload({
    kind: 'image',
    name: 'logo.png',
    mimeType: 'image/png',
    data: png,
  })
  const id = (upload as { id: string }).id
  expect(await service.setProjectAvatar({ path, avatar: 'image', image: id })).toMatchObject({
    avatar: 'image',
    image: id,
  })
  // It survives a restart, and a renamed project keeps it.
  await service.renameProject({ path, name: 'Client site' })
  const store = new ProjectStore(join(directory, 'projects.json'))
  await store.load()
  expect(store.projects.get(path)).toMatchObject({
    name: 'Client site',
    avatar: 'image',
    image: id,
  })
  const automatic = await service.setProjectAvatar({ path, avatar: 'auto' })
  expect(automatic.avatar).toBeUndefined()
  expect(automatic.image).toBeUndefined()
  await expect(
    service.setProjectAvatar({ path: join(directory, 'unknown'), avatar: 'letter' }),
  ).rejects.toThrow('Project not found')
})
it('removes a project together with its threads, unless one is running', async () => {
  const { mkdir, realpath } = await import('node:fs/promises')
  await mkdir(join(directory, 'busy-project'))
  const busy = await realpath(join(directory, 'busy-project'))
  const first = await service.create({ provider: 'codex', cwd: busy })
  const second = await service.create({ provider: 'codex', cwd: busy })
  const elsewhere = await thread()
  await service.addProject({ path: busy })
  // Without asking for its threads to go too, it's refused as before.
  await expect(service.removeProject({ path: busy })).rejects.toThrow(
    'Delete this project’s threads',
  )
  // A running thread blocks it, and nothing is deleted.
  await service.send(first.id, { text: 'Work' })
  await started
  await expect(service.removeProject({ path: busy, threads: true })).rejects.toThrow(
    'Stop the running threads',
  )
  expect(service.get(second.id)).toBeTruthy()
  await settle(first.id, finish)
  expect(await service.removeProject({ path: busy, threads: true })).toEqual({
    ok: true,
    deletedThreads: 2,
  })
  expect(() => service.get(first.id)).toThrow('Thread not found')
  expect(() => service.get(second.id)).toThrow('Thread not found')
  expect(service.projects().map((project) => project.path)).not.toContain(busy)
  // Other projects' threads stay, and the deletion is saved.
  expect(service.get(elsewhere.id)).toBeTruthy()
  const saved = JSON.parse(await readFile(join(directory, 'threads.json'), 'utf8'))
  expect(saved.map((item: { id: string }) => item.id)).toEqual([elsewhere.id])
})
it('switches agents mid-thread with a recap, and resumes a parked session on switching back', async () => {
  const calls: { provider: string; prompt: string; resume?: string }[] = []
  const fake =
    (provider: 'claude' | 'codex'): Runner =>
    async (ctx) => {
      calls.push({ provider, prompt: ctx.prompt, resume: ctx.thread.sessionId })
      ctx.session(ctx.thread.sessionId ?? `${provider}-session`)
      ctx.turnStarted?.(`turn-${calls.length}`)
      ctx.text(`reply-${calls.length}`, `${provider} answer ${calls.length}`)
    }
  const switching = new AgentService(new ThreadStore(join(directory, 'switch.json')), {
    codex: fake('codex'),
    claude: fake('claude'),
  })
  const settings = { model: '', effort: '', permissionMode: 'full-access' }
  const turn = async (id: string, text: string) => {
    const done = new Promise<void>((resolve) => {
      const unsubscribe = switching.subscribe(() => {
        const current = switching.get(id)
        if (current.status === 'completed' && current.messages.at(-1)?.role === 'assistant') {
          unsubscribe()
          resolve()
        }
      })
    })
    await switching.send(id, { text })
    await done
  }
  try {
    const created = await switching.create({ provider: 'codex', cwd: directory })
    await turn(created.id, 'First question')
    expect(calls[0]).toEqual({ provider: 'codex', prompt: 'First question', resume: undefined })

    // Codex → Claude: Claude starts its own session with a recap of the first turn.
    await switching.updateSettings(created.id, { provider: 'claude', ...settings })
    expect(switching.get(created.id).sessions?.codex?.id).toBe('codex-session')
    await turn(created.id, 'Second question')
    expect(calls[1]!.provider).toBe('claude')
    expect(calls[1]!.resume).toBeUndefined()
    expect(calls[1]!.prompt).toContain('switched to you from Codex')
    expect(calls[1]!.prompt).toContain('First question')
    expect(calls[1]!.prompt).toContain('codex answer 1')
    expect(calls[1]!.prompt.endsWith('Second question')).toBe(true)
    expect(switching.get(created.id).handoff).toBeUndefined()

    // A second Claude turn needs no recap.
    await turn(created.id, 'Third question')
    expect(calls[2]!.prompt).toBe('Third question')

    // Back to Codex: its parked session resumes, with a recap of only the turns it missed.
    await switching.updateSettings(created.id, { provider: 'codex', ...settings })
    await turn(created.id, 'Fourth question')
    expect(calls[3]!.resume).toBe('codex-session')
    expect(calls[3]!.prompt).toContain('switched to you from Claude')
    expect(calls[3]!.prompt).toContain('Second question')
    expect(calls[3]!.prompt).toContain('claude answer 3')
    expect(calls[3]!.prompt).not.toContain('First question')
    const final = switching.get(created.id)
    expect(final.sessions?.claude?.id).toBe('claude-session')
    // Each turn records the agent that ran it.
    expect(
      final.messages.filter((message) => message.role === 'user').map((m) => m.provider),
    ).toEqual(['codex', 'claude', 'claude', 'codex'])
  } finally {
    await switching.close()
  }
})
it('does not switch agents while the agent waits on you', async () => {
  const created = await thread()
  await service.send(created.id, { text: 'Hello' })
  await started
  service.get(created.id).approvals.push({ id: 'a', title: 'Run?', detail: '' })
  await expect(
    service.updateSettings(created.id, {
      provider: 'claude',
      model: '',
      effort: '',
      permissionMode: 'full-access',
    }),
  ).rejects.toThrow()
  expect(service.get(created.id).provider).toBe('codex')
  finish()
})
it('reports the git branch of a thread project, or none outside a repository', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const created = await thread()
  expect(await service.gitInfo(created.id)).toEqual({ branch: null })
  const git = promisify(execFile)
  await git('git', ['-C', created.cwd, 'init', '-q', '-b', 'feature/test-branch'])
  expect(await service.gitInfo(created.id)).toEqual({ branch: 'feature/test-branch' })
  // A GitHub origin links to the repository until the branch tracks a remote branch.
  await git('git', ['-C', created.cwd, 'remote', 'add', 'origin', 'git@github.com:edwin/demo.git'])
  expect(await service.gitInfo(created.id)).toEqual({
    branch: 'feature/test-branch',
    url: 'https://github.com/edwin/demo',
  })
  await git('git', ['-C', created.cwd, 'config', 'branch.feature/test-branch.remote', 'origin'])
  await git('git', [
    '-C',
    created.cwd,
    'config',
    'branch.feature/test-branch.merge',
    'refs/heads/feature/test-branch',
  ])
  expect(await service.gitInfo(created.id)).toEqual({
    branch: 'feature/test-branch',
    url: 'https://github.com/edwin/demo/tree/feature/test-branch',
  })
})
it('finds the pull request for a pushed branch from GitHub-style refs/pull refs', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd })
  const { mkdir, realpath } = await import('node:fs/promises')
  // A bare repository standing in for GitHub, with PR refs, and a clone tracking it.
  const remote = join(directory, 'remote.git')
  const work = join(directory, 'work')
  await mkdir(work)
  await run(directory, 'init', '-q', '--bare', remote)
  await run(work, 'init', '-q', '-b', 'feature/login')
  await run(
    work,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'one',
  )
  await run(work, 'remote', 'add', 'origin', remote)
  await run(work, 'push', '-q', '-u', 'origin', 'feature/login')
  const head = (await run(work, 'rev-parse', 'HEAD')).stdout.trim()
  // PR 7 is merged (only its head ref is left); PR 9 is open (it also has a merge ref).
  await run(remote, 'update-ref', 'refs/pull/7/head', head)
  await run(remote, 'update-ref', 'refs/pull/9/head', head)
  await run(remote, 'update-ref', 'refs/pull/9/merge', head)
  const created = await service.create({ provider: 'codex', cwd: await realpath(work) })
  // A local path isn't GitHub, so no link…
  expect(await service.pullRequest(created.id)).toBeNull()
  // …but with a GitHub URL (rewritten locally to the bare repo), the newest PR is found.
  await run(work, 'config', `url.${remote}.insteadOf`, 'git@github.com:edwin/demo.git')
  await run(work, 'remote', 'set-url', 'origin', 'git@github.com:edwin/demo.git')
  expect(await service.pullRequest(created.id)).toEqual({
    number: 9,
    url: 'https://github.com/edwin/demo/pull/9',
  })
  // Once PR 9 is merged too (GitHub drops its merge ref), there's no link…
  await run(remote, 'update-ref', '-d', 'refs/pull/9/merge')
  await new Promise((resolve) => setTimeout(resolve, 0))
  ;(service as unknown as { pullRefs: Map<string, unknown> }).pullRefs.clear()
  expect(await service.pullRequest(created.id)).toBeNull()
  await run(remote, 'update-ref', 'refs/pull/9/merge', head)
  ;(service as unknown as { pullRefs: Map<string, unknown> }).pullRefs.clear()
  // The default branch never shows one: its tip can be an old PR's head after a merge.
  await run(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature/login')
  expect(await service.pullRequest(created.id)).toBeNull()
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
it('opens only the thread project folder in VS Code', async () => {
  const { writeFile, chmod } = await import('node:fs/promises')
  const script = join(directory, 'fake-code.sh')
  const log = join(directory, 'opened.txt')
  // Records the folder it was asked to open; answers --version like the real CLI.
  await writeFile(
    script,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; exit 0; fi\nprintf '%s' "$1" > '${log}'\n`,
  )
  await chmod(script, 0o755)
  const previous = process.env.VSCODE_BIN
  process.env.VSCODE_BIN = script
  try {
    const created = await thread()
    expect((await service.bootstrap()).editors.vscode).toBe(true)
    await service.openInEditor(created.id)
    expect(await readFile(log, 'utf8')).toBe(created.cwd)
  } finally {
    if (previous === undefined) delete process.env.VSCODE_BIN
    else process.env.VSCODE_BIN = previous
  }
})
it('attaches tool content to the current reply, or to a reply of its own', async () => {
  const created = await thread()
  await service.send(created.id, { text: 'Show me a screenshot' })
  await started
  // Nothing written yet in this turn: the image gets a reply of its own.
  context.tools.attach({ type: 'image', id: 'a.png' })
  expect(created.messages.at(-1)).toMatchObject({
    role: 'assistant',
    text: '',
    blocks: [{ id: 'a.png' }],
  })
  // After the agent writes, more content joins that reply.
  context.text('reply', 'Here it is:')
  context.tools.attach({ type: 'image', id: 'b.png', caption: 'Second' })
  expect(created.messages.at(-1)).toMatchObject({
    text: 'Here it is:',
    blocks: [{ id: 'b.png', caption: 'Second' }],
  })
  await settle(created.id, finish)
})
it("lets a thread's tools manage only its own project's processes", async () => {
  const { mkdir } = await import('node:fs/promises')
  const { vi } = await import('vitest')
  vi.stubEnv('SHELL', '/bin/sh')
  try {
    const created = await thread()
    await service.send(created.id, { text: 'Start the dev server' })
    await started
    const processes = context.tools.processes
    await expect(processes.start({ name: 'x', command: 'true', cwd: '../' })).rejects.toThrow(
      'inside the project',
    )
    // A folder that isn't there is named plainly (not "spawn /bin/sh ENOENT").
    await expect(processes.start({ name: 'x', command: 'true', cwd: 'web' })).rejects.toThrow(
      'Folder not found: web (cwd is relative to the project folder',
    )
    await mkdir(join(created.cwd, 'web'))
    const info = await processes.start({ name: 'Web', command: 'exec sleep 60', cwd: 'web' })
    expect(info).toMatchObject({
      project: created.cwd,
      cwd: join(created.cwd, 'web'),
      threadId: created.id,
    })
    expect(service.snapshot().processes.map((item) => item.id)).toContain(info.id)
    // A process from another project is invisible to this thread's tools.
    const other = service.processes.start({
      name: 'Other',
      command: 'exec sleep 60',
      cwd: tmpdir(),
      project: '/other',
    })
    expect(() => processes.logs(other.id)).toThrow('No process')
    await expect(processes.stop(other.id)).rejects.toThrow('No process')
    await processes.stop(info.id)
    await service.processes.stop(other.id)
    await settle(created.id, finish)
  } finally {
    vi.unstubAllEnvs()
  }
})

describe('editing the last message after a stop', () => {
  // A fake agent that hands each turn's context to the test and waits to be told how it ends.
  let turns: { ctx: ProviderContext; end: (error?: Error) => void }[]
  let nextTurn: () => Promise<{ ctx: ProviderContext; end: (error?: Error) => void }>
  let editService: AgentService
  const scripted =
    (onRun?: (ctx: ProviderContext) => void): Runner =>
    (ctx) =>
      new Promise<void>((resolve, fail) => {
        onRun?.(ctx)
        ctx.session(ctx.thread.sessionId ?? 'session-1')
        const turn = { ctx, end: (error?: Error) => (error ? fail(error) : resolve()) }
        ctx.signal.addEventListener('abort', () => fail(new Error('Stopped')), { once: true })
        turns.push(turn)
      })
  const setup = (runner: Runner) => {
    turns = []
    editService = new AgentService(new ThreadStore(join(directory, 'edit-threads.json')), {
      codex: runner,
      claude: runner,
    })
    // Turns are handed out in order, whether they started before or after the call.
    let taken = 0
    nextTurn = async () => {
      while (turns.length <= taken) await new Promise((resolve) => setTimeout(resolve, 1))
      return turns[taken++]
    }
  }
  const finishTurn = async (id: string, end: () => void) => {
    const done = new Promise<void>((resolve) => {
      const unsubscribe = editService.subscribe(() => {
        if (!['starting', 'working', 'waiting'].includes(editService.get(id).status)) {
          unsubscribe()
          resolve()
        }
      })
    })
    end()
    await done
  }
  afterEach(() => editService?.close())

  it('rewinds Claude to before the stopped turn and replaces the message', async () => {
    setup(scripted())
    const created = await editService.create({ provider: 'claude', cwd: directory })
    // Turn 1 completes; its last conversation entry is where a rewind resumes.
    await editService.send(created.id, { text: 'First' })
    const first = await nextTurn()
    first.ctx.entry?.('entry-1')
    first.ctx.text('a1', 'Done')
    await finishTurn(created.id, () => first.end())
    // Turn 2 is stopped part-way.
    await editService.send(created.id, { text: 'Second, wrong' })
    const second = await nextTurn()
    second.ctx.entry?.('entry-2')
    second.ctx.text('a2', 'Half an answer')
    await editService.stop(created.id)
    const target = editService.get(created.id).messages.at(-2)!
    expect(target.text).toBe('Second, wrong')
    expect(target.turn).toEqual({ claudeResumeAt: 'entry-1', claudePrompt: second.ctx.promptId })

    await editService.edit(created.id, { messageId: target.id, text: 'Second, fixed' })
    const third = await nextTurn()
    expect(third.ctx.rewind).toEqual(target.turn)
    expect(third.ctx.prompt).toBe('Second, fixed')
    // The stopped message and its partial reply are gone; the edit takes their place.
    expect(editService.get(created.id).messages.map((message) => message.text)).toEqual([
      'First',
      'Done',
      'Second, fixed',
    ])
    third.ctx.rewound?.(true)
    expect(editService.get(created.id).rewind).toBeUndefined()
    await finishTurn(created.id, () => third.end())
  })

  it('starts a new Claude session when the stopped turn was the first', async () => {
    setup(scripted())
    const created = await editService.create({ provider: 'claude', cwd: directory })
    await editService.send(created.id, { text: 'Oops' })
    await nextTurn()
    await editService.stop(created.id)
    // Stop shows at once; the stopped turn is saved once the agent has exited.
    await editService.windDown(created.id)
    const target = editService.get(created.id).messages.at(-1)!
    expect(target.turn?.fresh).toBe(true)
    let sessionAtStart: string | undefined = 'unset'
    setup(scripted((ctx) => (sessionAtStart = ctx.thread.sessionId)))
    // Same data file, so the new service sees the stopped thread (as after a restart).
    await editService.store.load()
    await editService.edit(created.id, { messageId: target.id, text: 'Better' })
    const retry = await nextTurn()
    expect(sessionAtStart).toBeUndefined()
    expect(retry.ctx.rewind).toBeUndefined()
    await finishTurn(created.id, () => retry.end())
  })

  it('reverts the Codex turn by id', async () => {
    setup(scripted())
    const created = await editService.create({ provider: 'codex', cwd: directory })
    await editService.send(created.id, { text: 'Do it' })
    const first = await nextTurn()
    first.ctx.turnStarted?.('turn-9')
    await editService.stop(created.id)
    const target = editService.get(created.id).messages.at(-1)!
    expect(target.turn).toEqual({ codexTurn: 'turn-9' })
    await editService.edit(created.id, { messageId: target.id, text: 'Do it better' })
    const second = await nextTurn()
    expect(second.ctx.rewind).toEqual({ codexTurn: 'turn-9' })
    second.ctx.rewound?.(false)
    // Codex couldn't revert: the edit still ran, and the message says so.
    expect(editService.get(created.id).messages.at(-1)?.rewindFailed).toBe(true)
    await finishTurn(created.id, () => second.end())
  })

  it('falls back to a plain follow-up when Claude refuses the rewind', async () => {
    let calls = 0
    setup(
      scripted(() => {
        calls++
      }),
    )
    const created = await editService.create({ provider: 'claude', cwd: directory })
    await editService.send(created.id, { text: 'One' })
    const first = await nextTurn()
    first.ctx.entry?.('entry-1')
    await finishTurn(created.id, () => first.end())
    await editService.send(created.id, { text: 'Two' })
    await nextTurn()
    await editService.stop(created.id)
    const target = editService.get(created.id).messages.at(-1)!
    await editService.edit(created.id, { messageId: target.id, text: 'Two, again' })
    const refused = await nextTurn()
    refused.end(new Error('Resume rejected by --resume-drops-turn: queued message in range'))
    const retry = await nextTurn()
    expect(retry.ctx.rewind).toBeUndefined()
    expect(calls).toBe(4)
    const edited = editService.get(created.id).messages.at(-1)!
    expect(edited.rewindFailed).toBe(true)
    expect(edited.turn).toBeUndefined()
    await finishTurn(created.id, () => retry.end())
  })

  it('retries the last message of a finished turn, rewinding Claude', async () => {
    setup(scripted())
    const created = await editService.create({ provider: 'claude', cwd: directory })
    await editService.send(created.id, { text: 'One' })
    const first = await nextTurn()
    first.ctx.entry?.('entry-1')
    await finishTurn(created.id, () => first.end())
    await editService.send(created.id, { text: 'Two' })
    const second = await nextTurn()
    second.ctx.entry?.('entry-2')
    await finishTurn(created.id, () => second.end())
    expect(editService.get(created.id).status).toBe('completed')
    const target = editService.get(created.id).messages.at(-1)!
    expect(target.text).toBe('Two')
    await editService.edit(created.id, { messageId: target.id, text: 'Two' })
    const retry = await nextTurn()
    expect(retry.ctx.rewind?.claudeResumeAt).toBe('entry-1')
    const texts = editService.get(created.id).messages.map((message) => message.text)
    expect(texts).toEqual(['One', 'Two'])
    expect(editService.get(created.id).messages.at(-1)!.id).not.toBe(target.id)
    await finishTurn(created.id, () => retry.end())
  })

  it('refuses edits that are not your last message, or while the agent works', async () => {
    setup(scripted())
    const created = await editService.create({ provider: 'claude', cwd: directory })
    await editService.send(created.id, { text: 'Finish normally' })
    const first = await nextTurn()
    await finishTurn(created.id, () => first.end())
    const sent = editService.get(created.id).messages[0]
    await editService.send(created.id, { text: 'Then this' })
    const second = await nextTurn()
    await finishTurn(created.id, () => second.end())
    await expect(
      editService.edit(created.id, { messageId: sent.id, text: 'Rewrite history' }),
    ).rejects.toThrow('Only your last message')
    await editService.send(created.id, { text: 'Working' })
    await nextTurn()
    await expect(
      editService.edit(created.id, { messageId: sent.id, text: 'Mid-turn' }),
    ).rejects.toThrow('Stop the agent')
    await editService.stop(created.id)
  })
})

describe('AI thread titles', () => {
  const calls: string[] = []
  const writer = (overrides: Partial<TitleWriter> = {}): TitleWriter => ({
    claudeSession: async (sessionId) => {
      calls.push(`claudeSession ${sessionId}`)
      return 'Claude session title'
    },
    claude: async (conversation) => {
      calls.push(`claude ${conversation.split('\n')[0]}`)
      return 'Fresh Haiku title'
    },
    codex: async (conversation) => {
      calls.push(`codex ${conversation.split('\n')[0]}`)
      return 'Luna title'
    },
    nameCodexThread: async (threadId, name) => {
      calls.push(`name ${threadId} ${name}`)
    },
    ...overrides,
  })
  let titled: AgentService
  const make = (titles: TitleWriter) => {
    calls.length = 0
    titled = new AgentService(
      new ThreadStore(join(directory, 'titled.json')),
      { codex: runner, claude: runner },
      undefined,
      undefined,
      undefined,
      titles,
    )
  }
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20))
  // Ends the fake turn and waits for this service (not the shared one) to see it finish.
  const settleTitled = (id: string) =>
    new Promise<void>((resolve) => {
      const unsubscribe = titled.subscribe(() => {
        if (!['starting', 'working', 'waiting'].includes(titled.get(id).status)) {
          unsubscribe()
          resolve()
        }
      })
      finish()
    })
  afterEach(() => titled?.close())

  it('names a Codex thread right after the first message, and in Codex too', async () => {
    make(writer())
    const created = await titled.create({ provider: 'codex', cwd: directory })
    await titled.send(created.id, { text: 'Fix the overflowing code blocks' })
    await started
    // Titles are written in the background: wait for it (slower machines, e.g. CI, need longer).
    await vi.waitFor(() =>
      expect(titled.get(created.id)).toMatchObject({ title: 'Luna title', titleSource: 'ai' }),
    )
    expect(calls).toEqual([
      'codex User: Fix the overflowing code blocks',
      'name native-session Luna title',
    ])
    await settleTitled(created.id)
  })

  it('uses Claude’s own session title once the first turn ends', async () => {
    make(writer())
    const created = await titled.create({ provider: 'claude', cwd: directory })
    await titled.send(created.id, { text: 'Explain the tool system please' })
    await started
    expect(titled.get(created.id)).toMatchObject({
      title: 'Explain the tool system please',
      titleSource: 'message',
    })
    finish()
    await new Promise<void>((resolve) => {
      const unsubscribe = titled.subscribe(() => {
        if (titled.get(created.id).title === 'Claude session title') {
          unsubscribe()
          resolve()
        }
      })
    })
    expect(calls).toEqual(['claudeSession native-session'])
  })

  it('uses Claude’s session title as soon as Claude starts replying', async () => {
    make(writer())
    const created = await titled.create({ provider: 'claude', cwd: directory })
    await titled.send(created.id, { text: 'Explain the tool system please' })
    await started
    context.text('reply', 'The tool system')
    context.text('reply', ' has a registry…')
    await vi.waitFor(() =>
      expect(titled.get(created.id)).toMatchObject({
        title: 'Claude session title',
        titleSource: 'ai',
      }),
    )
    // One look while replying (throttled); none needed at the end.
    expect(calls).toEqual(['claudeSession native-session'])
    await settleTitled(created.id)
    expect(calls).toEqual(['claudeSession native-session'])
  })

  it('looks again at the end when the title wasn’t ready while Claude replied', async () => {
    let ready = false
    make(
      writer({
        claudeSession: async (sessionId) => {
          calls.push(`claudeSession ${sessionId}`)
          return ready ? 'Claude session title' : undefined
        },
      }),
    )
    const created = await titled.create({ provider: 'claude', cwd: directory })
    await titled.send(created.id, { text: 'Explain the tool system please' })
    await started
    context.text('reply', 'Early reply')
    await settled()
    expect(titled.get(created.id).titleSource).toBe('message')
    ready = true
    await settleTitled(created.id)
    await vi.waitFor(() =>
      expect(titled.get(created.id)).toMatchObject({ title: 'Claude session title' }),
    )
    expect(calls).toEqual(['claudeSession native-session', 'claudeSession native-session'])
  })

  it('never replaces a title you or the agent chose', async () => {
    make(writer())
    const created = await titled.create({ provider: 'codex', cwd: directory })
    await titled.send(created.id, { text: 'Something' })
    await titled.rename(created.id, { title: 'My own name' })
    await settled()
    expect(titled.get(created.id)).toMatchObject({ title: 'My own name', titleSource: 'custom' })
    await settleTitled(created.id)
  })

  it('regenerates with Haiku for Claude and Luna for Codex, and keeps the title on failure', async () => {
    make(writer({ codex: async () => undefined }))
    const claude = await titled.create({ provider: 'claude', cwd: directory })
    await expect(titled.regenerateTitle(claude.id)).rejects.toThrow('Send a message first')
    claude.messages.push({ id: 'u', role: 'user', text: 'Plan the release', createdAt: '' })
    await titled.regenerateTitle(claude.id)
    expect(titled.get(claude.id).title).toBe('Fresh Haiku title')
    const codex = await titled.create({ provider: 'codex', cwd: directory })
    codex.messages.push({ id: 'u2', role: 'user', text: 'Ship it', createdAt: '' })
    codex.title = 'Ship it'
    await expect(titled.regenerateTitle(codex.id)).rejects.toThrow('Couldn’t write a title')
    expect(titled.get(codex.id).title).toBe('Ship it')
  })
})
it('shows a stop at once, and a message sent while the agent exits waits for it', async () => {
  const prompts: string[] = []
  let first: ProviderContext | undefined
  let exit!: () => void
  // The first turn takes its time to exit after being stopped, like Claude Code does.
  const runner: Runner = (ctx) =>
    new Promise<void>((resolve) => {
      prompts.push(ctx.prompt)
      if (prompts.length > 1) return resolve()
      first = ctx
      ctx.session('session-1')
      ctx.signal.addEventListener('abort', () => (exit = resolve), { once: true })
    })
  const stopping = new AgentService(new ThreadStore(join(directory, 'stop-threads.json')), {
    claude: runner,
    codex: runner,
  })
  const created = await stopping.create({ provider: 'claude', cwd: directory })
  await stopping.send(created.id, { text: 'Long job' })
  while (!first) await new Promise((resolve) => setTimeout(resolve, 1))
  await stopping.stop(created.id)
  expect(stopping.get(created.id).status).toBe('interrupted')
  // Output that arrives while it exits doesn't bring it back to working.
  first.text('late', 'Still going')
  expect(stopping.get(created.id).status).toBe('interrupted')
  // A new message waits for the old run to exit, then starts a turn of its own.
  const sending = stopping.send(created.id, { text: 'Next' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(prompts).toEqual(['Long job'])
  exit()
  expect(await sending).toEqual({ accepted: true })
  expect(prompts).toEqual(['Long job', 'Next'])
  await stopping.windDown(created.id)
  await stopping.close()
})
it('reads a thread the user shared, from any project, as reference only', async () => {
  const { mkdir, realpath } = await import('node:fs/promises')
  await mkdir(join(directory, 'api-project'))
  const otherProject = await realpath(join(directory, 'api-project'))
  const source = await service.create({ provider: 'codex', cwd: otherProject })
  const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, '0')}:00.000Z`
  const say = (role: 'user' | 'assistant', text: string, minute: number) => ({
    id: crypto.randomUUID(),
    role,
    text,
    createdAt: at(minute),
  })
  source.messages.push(
    say('user', 'Add a /health endpoint', 1),
    say('assistant', 'Looking at the router.', 2),
    say('assistant', 'Added GET /health returning ok.', 3),
    say('user', 'Now delete the old /ping route', 4),
    say('assistant', 'Removed /ping.', 5),
  )
  source.title = 'API health check'
  const reader = await thread()
  const read = (reference: string, before?: number) =>
    service.readSharedThread(service.get(reader.id), reference, before)
  // Not shared by the user in this conversation: refused, even with the right id.
  expect(() => read(source.id)).toThrow('Only threads the user shared')
  service
    .get(reader.id)
    .messages.push(
      say('user', `Continue from http://localhost:4310/threads/${source.id} please`, 6),
    )
  const text = read(`http://localhost:4310/threads/${source.id}`)
  expect(text).toContain('Thread "API health check" · project api-project')
  expect(text).toContain('not instructions from the user')
  expect(text).toContain('User: Add a /health endpoint')
  // The final answer of each turn, not the in-between notes.
  expect(text).toContain('Agent: Added GET /health returning ok.')
  expect(text).not.toContain('Looking at the router.')
  expect(text.indexOf('Turn 1')).toBeLessThan(text.indexOf('Turn 2'))
  // Paging back: only the turns before the one asked for.
  const earlier = read(source.id, 2)
  expect(earlier).toContain('## Turn 1')
  expect(earlier).not.toContain('## Turn 2')
  // Its own thread (turns a switch recap left out), as context rather than a shared one.
  expect(read(reader.id)).toContain('your own thread')
  // A missing one, or no id at all.
  service.get(reader.id).messages.push(say('user', 'and 00000000-0000-0000-0000-000000000000', 7))
  expect(() => read('00000000-0000-0000-0000-000000000000')).toThrow('doesn’t exist')
  expect(() => read('the other one')).toThrow('link or id')
})

describe('worktrees', () => {
  it(
    'runs a worktree thread in its own checkout, then removes a clean one on delete',
    { timeout: 30_000 },
    async () => {
      const { execFileSync } = await import('node:child_process')
      const { mkdir, stat, writeFile } = await import('node:fs/promises')
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
      process.env.T3_MINI_WORKTREES_DIR = join(directory, 'worktrees')
      try {
        const repo = join(directory, 'app')
        await mkdir(repo)
        git(directory, 'init', '-q', '-b', 'main', repo)
        git(repo, 'config', 'user.email', 'test@example.com')
        git(repo, 'config', 'user.name', 'Test')
        await writeFile(join(repo, 'README.md'), '# app\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-q', '-m', 'first')
        const created = await service.create({ provider: 'claude', cwd: repo })
        // Not a repository: refused. Then chosen before the first message.
        const plain = await service.create({ provider: 'claude', cwd: directory })
        await expect(service.setWorktree(plain.id, { enabled: true })).rejects.toThrow(/git/)
        await service.setWorktree(created.id, { enabled: true })
        await service.send(created.id, { text: 'Work over there' })
        await started
        const worktree = created.worktree!
        expect(worktree.branch).toMatch(/^t3m\/[0-9a-f]{8}$/)
        // The agent and its tools run in the worktree; the thread stays in its project.
        expect(context.cwd).toBe(worktree.path)
        expect(context.tools.cwd).toBe(worktree.path)
        expect(created.cwd).toBe(worktree.repo)
        expect(created.activities[0]).toMatchObject({ label: 'Worktree', status: 'completed' })
        expect(service.list().find((item) => item.id === created.id)?.worktreeBranch).toBe(
          worktree.branch,
        )
        await settle(created.id, finish)
        // Too late to change where it works.
        await expect(service.setWorktree(created.id, { enabled: false })).rejects.toThrow(
          /new thread/,
        )
        expect(await service.remove(created.id)).toEqual({ ok: true })
        await expect(stat(worktree.path)).rejects.toThrow()
        expect(git(repo, 'branch', '--list', worktree.branch)).toContain(worktree.branch)
      } finally {
        delete process.env.T3_MINI_WORKTREES_DIR
      }
    },
  )
})

describe('orchestration', () => {
  it(
    'lets a lead start, list, message, and delete helpers that report back',
    { timeout: 30_000 },
    async () => {
      // Waits for something to happen (git and turns take longer on slow machines, e.g. CI).
      const until = async <T>(check: () => T, ms = 15_000): Promise<NonNullable<T>> => {
        for (const start = Date.now(); Date.now() - start < ms;) {
          const value = check()
          if (value) return value as NonNullable<T>
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('Timed out waiting.')
      }
      const { execFileSync } = await import('node:child_process')
      const { mkdir, stat, writeFile } = await import('node:fs/promises')
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
      process.env.T3_MINI_WORKTREES_DIR = join(directory, 'worktrees')
      // A runner per thread: each turn waits until the test ends it with a reply.
      const turns = new Map<string, { ctx: ProviderContext; end: (reply: string) => void }[]>()
      const turnStarted = new Map<string, () => void>()
      const nextTurn = (id: string) =>
        new Promise<void>((resolve) => turnStarted.set(id, resolve)).then(() =>
          turns.get(id)!.at(-1)!,
        )
      const orchestrated = new AgentService(new ThreadStore(join(directory, 'orch.json')), {
        codex: async () => {},
        claude: async (ctx) => {
          await new Promise<void>((resolve) => {
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
            turnStarted.get(ctx.thread.id)?.()
          })
        },
      })
      try {
        const repo = join(directory, 'app')
        await mkdir(repo)
        git(directory, 'init', '-q', '-b', 'main', repo)
        git(repo, 'config', 'user.email', 'test@example.com')
        git(repo, 'config', 'user.name', 'Test')
        await writeFile(join(repo, 'README.md'), '# app\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-q', '-m', 'first')
        const lead = await orchestrated.create({ provider: 'claude', cwd: repo })
        let leadTurn = nextTurn(lead.id)
        await orchestrated.send(lead.id, { text: 'Split the work' })
        const first = await leadTurn
        const control = first.ctx.tools.threads
        const started = await control.start({ task: 'Add a footer', title: 'Footer' })
        const helper = orchestrated.get(started.id)
        expect(helper).toMatchObject({ parentId: lead.id, title: 'Footer', useWorktree: true })
        expect(control.list()).toContain('"Footer"')
        // Only its own helpers.
        await expect(control.stop(lead.id)).rejects.toThrow(/isn’t one of your helper/)
        // The helper runs in its worktree, knows who it works for, and can't start helpers.
        const helperTurn = await until(() => turns.get(helper.id)?.at(-1))
        expect(helperTurn.ctx.cwd).toBe(helper.worktree!.path)
        expect(helperTurn.ctx.prompt).toContain('Task from the lead thread')
        await expect(helperTurn.ctx.tools.threads.start({ task: 'More' })).rejects.toThrow(
          /can’t start helpers/,
        )
        // The lead ends its turn; the helper finishing wakes it with a report.
        first.end('Started a helper.')
        await until(() => lead.status === 'completed')
        leadTurn = nextTurn(lead.id)
        helperTurn.end('Added the footer.')
        const woken = await leadTurn
        expect(woken.ctx.prompt).toContain('Report from helper thread "Footer"')
        expect(woken.ctx.prompt).toContain('Added the footer.')
        expect(lead.messages.find((message) => message.report)?.report).toMatchObject({
          threadId: helper.id,
          status: 'completed',
          branch: helper.worktree!.branch,
        })
        // The helper is readable from the lead without sharing its link.
        expect(orchestrated.readSharedThread(lead, helper.id)).toContain('Footer')
        woken.end('The footer is done.')
        await until(() => lead.status === 'completed')
        // Too many automatic turns in a row: the next report waits for the user.
        lead.autoTurns = 10
        const again = nextTurn(helper.id)
        expect(await woken.ctx.tools.threads.message(helper.id, 'Also a copyright line')).toContain(
          'Sent',
        )
        ;(await again).end('Added it.')
        await until(() => lead.messages.at(-1)?.unsent)
        expect(lead.messages.at(-1)).toMatchObject({ unsent: true, report: { title: 'Footer' } })
        expect(lead.status).toBe('completed')
        // Deleting removes the helper and its clean worktree.
        const path = helper.worktree!.path
        expect(await control.remove(helper.id)).toContain('Deleted "Footer"')
        await expect(stat(path)).rejects.toThrow()
        expect(() => orchestrated.get(helper.id)).toThrow()
      } finally {
        delete process.env.T3_MINI_WORKTREES_DIR
        await orchestrated.close()
      }
    },
  )
})

describe('threads without a project', () => {
  it('runs a chat in its own folder under "No project", and removes it only when empty', async () => {
    const { readdir, stat, writeFile } = await import('node:fs/promises')
    process.env.T3_MINI_CHATS_DIR = join(directory, 'chats')
    try {
      const created = await service.create({ provider: 'codex', noProject: true })
      expect(created.chat).toBe(true)
      expect(created.cwd.endsWith('/chats')).toBe(true)
      // Not saved as a project, but shown as "No project" while it has chats.
      expect(service.projectStore.projects.has(created.cwd)).toBe(false)
      expect(service.projects().find((project) => project.path === created.cwd)).toMatchObject({
        chats: true,
        name: 'No project',
      })
      await service.send(created.id, { text: 'Fix my résumé, please!' })
      await started
      const today = new Date().toISOString().slice(0, 10)
      expect(created.chatFolder).toBe(
        join(created.cwd, `${today}-fix-my-r-sum-please-${created.id.slice(0, 8)}`),
      )
      expect(context.cwd).toBe(created.chatFolder)
      expect(context.tools.cwd).toBe(created.chatFolder)
      expect(service.list().find((item) => item.id === created.id)?.chat).toBe(true)
      // A thread created in the chats folder (a chat's helper) is a chat too.
      expect((await service.create({ provider: 'codex', cwd: created.cwd })).chat).toBe(true)
      await settle(created.id, finish)
      // A file the agent made keeps the folder; an empty one goes.
      await writeFile(join(created.chatFolder!, 'notes.md'), 'hi\n')
      await service.remove(created.id)
      expect(await readdir(created.chatFolder!)).toEqual(['notes.md'])
      const empty = await service.create({ provider: 'codex', noProject: true })
      started = new Promise((resolve) => {
        markStarted = resolve
      })
      await service.send(empty.id, { text: 'Hello' })
      await started
      await settle(empty.id, finish)
      await service.remove(empty.id)
      await expect(stat(empty.chatFolder!)).rejects.toThrow()
    } finally {
      delete process.env.T3_MINI_CHATS_DIR
    }
  })
})
