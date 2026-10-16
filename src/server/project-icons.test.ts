import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ProjectIcons } from './project-icons'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-mini-icons-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(60)])
const project = async (name: string) => {
  const path = join(root, name)
  await mkdir(join(path, 'public'), { recursive: true })
  return path
}

it('finds a project’s icon from the well-known files, in order', async () => {
  const path = await project('app')
  await writeFile(join(path, 'public/favicon.ico'), png)
  await writeFile(
    join(path, 'public/favicon.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(40)}</svg>`,
  )
  const icons = new ProjectIcons()
  expect(await icons.read(path)).toMatchObject({ mimeType: 'image/svg+xml' })
  expect(icons.known(path)).toBe(true)
})

it('skips empty placeholders and files outside the project', async () => {
  const path = await project('laravel')
  await writeFile(join(path, 'public/favicon.ico'), '')
  const outside = join(root, 'secret.png')
  await writeFile(outside, png)
  await symlink(outside, join(path, 'public/favicon.png'))
  const icons = new ProjectIcons()
  expect(await icons.read(path)).toBeUndefined()
  expect(icons.known(path)).toBe(false)
  expect(await new ProjectIcons().read(join(root, 'missing'))).toBeUndefined()
})
