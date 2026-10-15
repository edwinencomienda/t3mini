import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { maxImageBytes } from '../uploads'
import { resolveAllowedFile } from './paths'
import { defineTool } from './types'

// Shows an image file (a screenshot, a generated chart, a design export…) in the chat.
// The file is copied into the thread's uploads, so it stays visible even if the original
// is later changed or deleted.
export const showImage = defineTool({
  name: 'show_image',
  label: 'Show image',
  description:
    'Show an image to the user inline in the chat. Use it when the user asks to see a screenshot, ' +
    'chart, diagram, or other image. First save the image as a PNG, JPEG, GIF, or WebP file inside ' +
    'the project folder or /tmp (for example with `screencapture -x /tmp/screen.png` on macOS), ' +
    'then call this with its path. Up to 10 MB.',
  input: {
    path: z
      .string()
      .min(1)
      .describe('Path to the image file, absolute or relative to the project.'),
    caption: z
      .string()
      .max(300)
      .optional()
      .describe('Optional short caption shown under the image.'),
  },
  safety: 'safe',
  summarize: (input) => (input.path ? basename(input.path) : undefined),
  async run(context, input) {
    const file = await resolveAllowedFile(context.cwd, input.path, maxImageBytes)
    const { id } = await context.saveImage(await readFile(file))
    context.attach({ type: 'image', id, ...(input.caption ? { caption: input.caption } : {}) })
    return `Shown to the user: ${basename(file)}.`
  },
})
