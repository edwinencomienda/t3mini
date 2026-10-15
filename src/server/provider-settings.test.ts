import { expect, it } from 'vitest'
import { claudeSettings, threadSettings } from './provider-settings'

it.each([
  ['approval-required', 'default', undefined],
  ['auto-accept-edits', 'acceptEdits', undefined],
  ['auto', 'auto', undefined],
  ['full-access', 'bypassPermissions', true],
] as const)(
  'maps %s to Claude native permissions',
  (permissionMode, nativeMode, allowDangerouslySkipPermissions) => {
    const options = claudeSettings({ model: 'sonnet', effort: 'high', permissionMode })
    expect(options).toMatchObject({ model: 'sonnet', effort: 'high', permissionMode: nativeMode })
    expect(options.allowDangerouslySkipPermissions).toBe(allowDangerouslySkipPermissions)
  },
)
it('leaves effort to Claude when Default is selected and rejects unsupported effort strings', () => {
  expect(
    claudeSettings({ model: '', effort: '', permissionMode: 'approval-required' }),
  ).not.toHaveProperty('effort')
  expect(() =>
    claudeSettings({ model: 'sonnet', effort: 'ultra', permissionMode: 'approval-required' }),
  ).toThrow()
})
it('preserves legacy thread permission behavior before a server restart migrates them', () => {
  expect(
    threadSettings({ provider: 'codex', model: '', effort: '', permissionMode: undefined! })
      .permissionMode,
  ).toBe('auto-accept-edits')
  expect(
    threadSettings({ provider: 'claude', model: '', effort: '', permissionMode: undefined! })
      .permissionMode,
  ).toBe('approval-required')
})
