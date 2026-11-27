import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { addProject, projectFolderProblem, realFolder } from './add-project'
import { runTool } from '.'
import type { ToolContext } from './types'

let home: string
let outside: string
beforeEach(async () => {
  // A throwaway home folder (os.homedir() reads HOME) and a folder outside it.
  home = await realpath(await mkdtemp(join(tmpdir(), 't3-add-project-home-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 't3-add-project-outside-')))
  vi.stubEnv('HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const context = (cwd = home) => {
  const addProjectMock = vi.fn<ToolContext['addProject']>(async (path, { check }) => {
    check(path)
    return { project: { path, lastActiveAt: '', addedAt: '', threadCount: 0 }, added: true }
  })
  return {
    addProjectMock,
    context: { cwd, addProject: addProjectMock } as unknown as ToolContext,
  }
}

it('needs approval, so it never runs without the user (unless the thread has full access)', () => {
  expect(addProject.safety).toBe('approval')
})
it('allows only folders inside home, not home itself or hidden folders', () => {
  expect(projectFolderProblem(join(home, 'projects', 'app'), home)).toBeUndefined()
  expect(projectFolderProblem(home, home)).toMatch(/home folder itself/)
  expect(projectFolderProblem(outside, home)).toMatch(/inside your home folder/)
  expect(projectFolderProblem(join(home, '..', 'other'), home)).toMatch(/inside your home/)
  expect(projectFolderProblem(join(home, '.ssh'), home)).toMatch(/hidden folder/)
  expect(projectFolderProblem(join(home, 'code', '.git', 'x'), home)).toMatch(/hidden folder/)
})
it('adds an existing folder, given with ~/', async () => {
  await mkdir(join(home, 'projects', 'app'), { recursive: true })
  const { context: ctx, addProjectMock } = context()
  const result = await runTool(addProject, ctx, { path: '~/projects/app' })
  expect(result.ok).toBe(true)
  expect(result.text).toContain('Added the project "app"')
  expect(addProjectMock).toHaveBeenCalledWith(join(home, 'projects', 'app'), {
    create: false,
    check: expect.any(Function),
  })
})
it('resolves relative paths from the thread folder', async () => {
  await mkdir(join(home, 'projects', 'app'), { recursive: true })
  await mkdir(join(home, 'projects', 'other'), { recursive: true })
  const { context: ctx, addProjectMock } = context(join(home, 'projects', 'app'))
  expect((await runTool(addProject, ctx, { path: '../other' })).ok).toBe(true)
  expect(addProjectMock.mock.calls[0][0]).toBe(join(home, 'projects', 'other'))
})
it('refuses a missing folder unless create is set', async () => {
  const { context: ctx, addProjectMock } = context()
  const refused = await runTool(addProject, ctx, { path: '~/projects/new' })
  expect(refused).toMatchObject({ ok: false })
  expect(refused.text).toMatch(/doesn’t exist.*create: true/)
  expect(addProjectMock).not.toHaveBeenCalled()

  const created = await runTool(addProject, ctx, { path: '~/projects/new', create: true })
  expect(created.text).toContain('Created and added')
  expect(addProjectMock.mock.calls[0][1].create).toBe(true)
})
it('refuses folders outside home, home itself, and hidden folders, before touching anything', async () => {
  await mkdir(join(home, '.config', 'app'), { recursive: true })
  const { context: ctx, addProjectMock } = context()
  for (const path of [outside, '~', '~/.config/app', '~/.ssh', '/etc', '~/../elsewhere'])
    expect((await runTool(addProject, ctx, { path, create: true })).ok).toBe(false)
  expect(addProjectMock).not.toHaveBeenCalled()
})
it('follows symlinks, so a link inside home can’t lead outside it', async () => {
  await symlink(outside, join(home, 'link'))
  const { context: ctx, addProjectMock } = context()
  for (const path of ['~/link', '~/link/new-folder']) {
    const result = await runTool(addProject, ctx, { path, create: true })
    expect(result.text).toMatch(/inside your home folder/)
  }
  expect(addProjectMock).not.toHaveBeenCalled()
  // A folder that doesn't exist yet resolves through its existing parent's links.
  expect(await realFolder(join(home, 'link', 'a', 'b'))).toEqual({
    path: join(outside, 'a', 'b'),
    exists: false,
  })
})
it('refuses a file', async () => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(home, 'notes.txt'), 'x')
  const { context: ctx } = context()
  expect((await runTool(addProject, ctx, { path: '~/notes.txt' })).text).toMatch(/Not a folder/)
})
it('reports a folder that is already a project', async () => {
  await mkdir(join(home, 'app'))
  const ctx = {
    cwd: home,
    addProject: async (path: string) => ({
      project: { path, name: 'My app', lastActiveAt: '', addedAt: '', threadCount: 2 },
      added: false,
    }),
  } as unknown as ToolContext
  expect((await runTool(addProject, ctx, { path: '~/app' })).text).toBe(
    `${join(home, 'app')} is already a project ("My app"). Nothing changed.`,
  )
})
