import type { Provider } from './types'

export const permissionModes = [
  {
    value: 'approval-required',
    label: 'Approval required',
    description: 'Ask before actions that need approval.',
  },
  {
    value: 'auto-accept-edits',
    label: 'Auto-accept edits',
    description: 'Allow project edits; ask when other actions need approval.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Let the provider review and approve actions automatically.',
  },
  {
    value: 'full-access',
    label: 'Full access',
    description: 'Run with full system access and bypass normal permission prompts.',
  },
] as const
export type PermissionMode = (typeof permissionModes)[number]['value']
export type AgentSettings = { model: string; effort: string; permissionMode: PermissionMode }
export type ModelOption = {
  id: string
  label: string
  description?: string
  efforts: string[]
  defaultEffort?: string
  isDefault?: boolean
}
export type ModelCatalog = { models: ModelOption[]; error?: string }
// New threads start with full access unless the user picked something else last time.
export const defaultPermission: PermissionMode = 'full-access'
// Threads saved before permission modes existed keep their original, more restrictive behavior.
export const legacyPermission = (provider: Provider): PermissionMode =>
  provider === 'codex' ? 'auto-accept-edits' : 'approval-required'
export const isPermissionMode = (value: unknown): value is PermissionMode =>
  permissionModes.some((item) => item.value === value)
export const effortLabel = (value: string) =>
  ({ xhigh: 'Extra high', ultra: 'Ultra', minimal: 'Minimal', none: 'None' })[value] ||
  value.charAt(0).toUpperCase() + value.slice(1)
