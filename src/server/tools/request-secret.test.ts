import { expect, it, vi } from 'vitest'
import { requestSecret } from './request-secret'
import { runTool } from '.'
import type { ToolContext } from './types'

const context = (askSecret: ToolContext['askSecret']) =>
  ({ cwd: process.cwd(), askSecret }) as unknown as ToolContext

it('asks for the secret and tells the agent only where it went', async () => {
  const askSecret = vi.fn(async () => ({ file: '.env.local', addedToGitignore: true }))
  const result = await runTool(requestSecret, context(askSecret), {
    name: 'STRIPE_SECRET_KEY',
    reason: 'To create test charges. Find it under Developers → API keys.',
  })
  expect(askSecret).toHaveBeenCalledWith({
    name: 'STRIPE_SECRET_KEY',
    reason: 'To create test charges. Find it under Developers → API keys.',
    file: '.env.local',
  })
  expect(result.text).toContain('saved STRIPE_SECRET_KEY to .env.local')
  expect(result.text).toContain('.gitignore')
  expect(result.text).toContain('not shown the value')
})

it('says when the user skipped it, and refuses odd names', async () => {
  const skipped = await runTool(
    requestSecret,
    context(async () => null),
    {
      name: 'API_KEY',
      reason: 'Needed for the client.',
    },
  )
  expect(skipped.text).toContain('skipped')
  const bad = await runTool(requestSecret, context(vi.fn()), { name: 'not a name', reason: 'x' })
  expect(bad.ok).toBe(false)
})
