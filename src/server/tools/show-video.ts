import { basename } from 'node:path'
import { z } from 'zod'
import { UploadError, maxVideoBytes } from '../uploads'
import { resolveAllowedFile } from './paths'
import { ToolError, defineTool } from './types'

// Shows a video file (a screen recording, a rendered animation, a demo) in the chat. Like
// show_image, the file is copied into the uploads after its real format is checked.
export const showVideo = defineTool({
  name: 'show_video',
  label: 'Show video',
  description:
    'Show a video to the user inline in the chat, with play controls: a screen recording, a ' +
    'rendered animation, a demo of a flow. Save it as an MP4 (H.264, plays everywhere), WebM, MOV, ' +
    'or Ogg file inside the project folder or /tmp, then call this with its path (e.g. ' +
    '`ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p /tmp/demo.mp4` to convert). Up to ' +
    `${maxVideoBytes / 1024 / 1024} MB.`,
  input: {
    path: z
      .string()
      .min(1)
      .describe('Path to the video file, absolute or relative to the project.'),
    caption: z.string().max(300).optional().describe('Optional short caption shown under it.'),
  },
  safety: 'safe',
  summarize: (input) => (input.path ? basename(input.path) : undefined),
  async run(context, input) {
    const file = await resolveAllowedFile(context.cwd, input.path, maxVideoBytes)
    const { id } = await context.saveMedia(file, 'video').catch((error: unknown) => {
      throw error instanceof UploadError ? new ToolError(error.message) : error
    })
    context.attach({ type: 'video', id, ...(input.caption ? { caption: input.caption } : {}) })
    return `Shown to the user: ${basename(file)}.`
  },
})
