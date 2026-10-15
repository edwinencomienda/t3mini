import { z } from 'zod'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { legacyPermission, type AgentSettings } from '../agent-settings'
import type { Thread } from '../types'

export const settingsSchema = z.object({
  model: z.string().trim().max(120),
  effort: z.string().trim().max(32),
  permissionMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
})
export const threadSettings = (
  thread: Pick<Thread, 'provider' | 'model' | 'effort' | 'permissionMode'>,
): AgentSettings => ({
  model: thread.model,
  effort: thread.effort || '',
  permissionMode: thread.permissionMode || legacyPermission(thread.provider),
})
export function codexPolicy(mode: AgentSettings['permissionMode']) {
  switch (mode) {
    case 'approval-required':
      return {
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        sandboxPolicy: { type: 'readOnly' },
      }
    case 'auto-accept-edits':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite' },
      }
    case 'auto':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite' },
      }
    case 'full-access':
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      }
  }
}
export function claudeSettings(settings: AgentSettings) {
  const modes = {
    'approval-required': 'default',
    'auto-accept-edits': 'acceptEdits',
    auto: 'auto',
    'full-access': 'bypassPermissions',
  } as const
  const effort = settings.effort
    ? z.enum(['low', 'medium', 'high', 'xhigh', 'max']).parse(settings.effort)
    : undefined
  return {
    permissionMode: modes[settings.permissionMode],
    ...(settings.permissionMode === 'full-access' ? { allowDangerouslySkipPermissions: true } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(effort ? { effort } : {}),
  } satisfies Partial<Options>
}
