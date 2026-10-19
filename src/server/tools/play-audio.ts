import { basename } from 'node:path'
import { z } from 'zod'
import { UploadError, maxAudioBytes } from '../uploads'
import { resolveAllowedFile } from './paths'
import { ToolError, defineTool } from './types'

// Shows a sound to the user: an audio player in the chat that they start themselves (nothing
// plays on its own). The file is copied into the uploads after its real format is checked.
// The name stays play_audio: Codex threads saved the tool under it.
export const playAudio = defineTool({
  name: 'play_audio',
  label: 'Play audio',
  description:
    'Show a sound to the user: an audio player appears in the chat and they press play when ' +
    'they want (it never starts on its own). For speech, music, a recording, or a generated sound. ' +
    'Save it as an MP3, M4A, WAV, Ogg, FLAC, or WebM file inside the project folder or /tmp, then ' +
    'call this with its path. On macOS, text to speech: `say -o /tmp/hello.m4a ' +
    '--file-format=m4af --data-format=aac "Hello"` (plain `say -o` writes AIFF, which browsers ' +
    `can't play). Up to ${maxAudioBytes / 1024 / 1024} MB.`,
  input: {
    path: z
      .string()
      .min(1)
      .describe('Path to the audio file, absolute or relative to the project.'),
    caption: z.string().max(300).optional().describe('Optional short caption shown with it.'),
  },
  safety: 'safe',
  summarize: (input) => (input.path ? basename(input.path) : undefined),
  async run(context, input) {
    const file = await resolveAllowedFile(context.cwd, input.path, maxAudioBytes)
    const { id } = await context.saveMedia(file, 'audio').catch((error: unknown) => {
      throw error instanceof UploadError ? new ToolError(error.message) : error
    })
    context.attach({ type: 'audio', id, ...(input.caption ? { caption: input.caption } : {}) })
    return `Shown to the user: ${basename(file)}. It doesn't play on its own; they press play.`
  },
})
