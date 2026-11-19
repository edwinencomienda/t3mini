import { z } from 'zod'
import { defineTool } from './types'
import { secretNamePattern } from '../secret-file'

// Asks the user for a secret (an API key, token, password) on a card with a password field, and
// saves it straight into the project's env file. The value never reaches the agent, the chat,
// the thread's saved history, live updates, notifications, or logs: the agent only learns that
// it was saved, and where (secret-file.ts writes it).
export const requestSecret = defineTool({
  name: 'request_secret',
  label: 'Ask for a secret',
  description:
    'Ask the user for a secret (an API key, token, password, or connection string) and save it ' +
    'straight into an env file in the project, without you ever seeing it. Use this whenever ' +
    'you need a credential: never ask for one in chat, and never ask the user to paste it into a ' +
    'message. The user gets a card with a password field; you get back only whether it was ' +
    'saved and to which file. Then load it from the environment in code (e.g. ' +
    'process.env.NAME); do not read, print, echo, or log the file or the value, and do not ' +
    'commit it. One secret per call.',
  input: {
    name: z
      .string()
      .trim()
      .regex(secretNamePattern, 'A variable name such as STRIPE_SECRET_KEY.')
      .describe('The environment variable name, e.g. "STRIPE_SECRET_KEY".'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe('One sentence the user sees: what it is for and where to get it.'),
    file: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        'The env file to save it in, relative to the project (default ".env.local"; must be an ' +
          'env file such as .env, .env.local, .env.development.local, or .dev.vars).',
      ),
  },
  safety: 'safe',
  summarize: (input) => input.name,
  async run(context, input) {
    const file = input.file || '.env.local'
    const result = await context.askSecret({ name: input.name, reason: input.reason, file })
    if (!result)
      return `The user skipped this; ${input.name} was not saved. Continue without it, or explain why it's needed.`
    return (
      `The user saved ${input.name} to ${result.file}` +
      (result.addedToGitignore ? ` (and added ${result.file} to .gitignore)` : '') +
      '. You were not shown the value. Load it from the environment; do not read, print, or log it.'
    )
  },
})
