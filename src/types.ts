import type { PermissionMode } from './agent-settings'

export type Provider = 'codex' | 'claude'
export type Status =
  'idle' | 'starting' | 'working' | 'waiting' | 'completed' | 'interrupted' | 'failed'
export type Message = { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }
export type Activity = {
  id: string
  label: string
  detail?: string
  status: 'running' | 'completed' | 'failed'
}
export type Approval = { id: string; title: string; detail: string }
export type Thread = {
  id: string
  title: string
  provider: Provider
  cwd: string
  model: string
  effort: string
  permissionMode: PermissionMode
  status: Status
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  sessionId?: string
  messages: Message[]
  activities: Activity[]
  approvals: Approval[]
  error?: string
}
export type ThreadSummary = Pick<
  Thread,
  'id' | 'title' | 'provider' | 'cwd' | 'status' | 'updatedAt'
>
export type ProviderHealth = { installed: boolean; version?: string }
export type Bootstrap = {
  threads: ThreadSummary[]
  providers: Record<Provider, ProviderHealth>
  defaultCwd: string
}
export const isActive = (status: Status) => ['starting', 'working', 'waiting'].includes(status)
