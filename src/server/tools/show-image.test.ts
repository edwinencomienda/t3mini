import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Uploads } from '../uploads'
import { showImage } from './show-image'
import type { ToolContext } from './types'
import type { Block } from '../../blocks'

// A real 1×1 PNG.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
let root: string
let project: string
let attach: ReturnType<typeof vi.fn<(block: Block) => void>>
let context: ToolContext

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 't3-mini-tools-')))
  project = join(root, 'project')
  await mkdir(project)
  const uploads = new Uploads(join(root, 'data', 'attachments'))
  attach = vi.fn<(block: Block) => void>()
  context = {
    cwd: project,
    attach,
    saveImage: (bytes) => uploads.saveImage(bytes),
    processes: {} as never,
  }
})
afterEach(() => rm(root, { recursive: true, force: true }))

it('shows an image from the project (relative path) with its caption', async () => {
  await writeFile(join(project, 'chart.png'), png)
  const result = await showImage.run(context, { path: 'chart.png', caption: 'Weekly signups' })
  expect(result).toBe('Shown to the user: chart.png.')
  expect(attach).toHaveBeenCalledWith({
    type: 'image',
    id: expect.stringMatching(/^[0-9a-f-]{36}\.png$/),
    caption: 'Weekly signups',
  })
})
it('allows the temp folder, where screenshots usually go', async () => {
  const file = join(tmpdir(), `t3-mini-shot-${Date.now()}.png`)
  await writeFile(file, png)
  try {
    await showImage.run(context, { path: file })
    expect(attach).toHaveBeenCalledTimes(1)
  } finally {
    await rm(file, { force: true })
  }
})
it('refuses files outside the project and temp folders, including ../ and symlinks', async () => {
  await expect(showImage.run(context, { path: '/etc/hosts' })).rejects.toThrow('Only files inside')
  const outside = join(process.cwd(), 'package.json')
  await expect(showImage.run(context, { path: outside })).rejects.toThrow('Only files inside')
  await symlink(outside, join(project, 'sneaky.png'))
  await expect(showImage.run(context, { path: 'sneaky.png' })).rejects.toThrow('Only files inside')
  await expect(showImage.run(context, { path: '../../../etc/hosts' })).rejects.toThrow()
  await expect(showImage.run(context, { path: 'missing.png' })).rejects.toThrow('not found')
  expect(attach).not.toHaveBeenCalled()
})
it('refuses files that are not really images', async () => {
  await writeFile(join(project, 'page.png'), '<html><script>alert(1)</script></html>')
  await expect(showImage.run(context, { path: 'page.png' })).rejects.toThrow('Only PNG')
  expect(attach).not.toHaveBeenCalled()
})
it('describes itself for the work log', () => {
  expect(showImage.label).toBe('Show image')
  expect(showImage.summarize?.({ path: '/tmp/screen.png' })).toBe('screen.png')
})
