import type { PermissionMode } from './agent-settings'

export type Provider = 'codex' | 'claude'
export type Status =
  'idle' | 'starting' | 'working' | 'waiting' | 'completed' | 'interrupted' | 'failed'
// An image sent with a message; served back for previews at /api/uploads/<id>.
export type Attachment = { id: string; name: string; mimeType: string }
export type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  attachments?: Attachment[]
}
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
> & {
  // When you last sent a message (or created the thread). The sidebar sorts by this, so
  // streaming agents don't keep reshuffling the list.
  lastMessageAt: string
}
// A project is a folder on this machine. Saved projects stay in the sidebar even without threads.
export type Project = { path: string; addedAt: string }
export type ProjectSummary = { path: string; lastActiveAt: string; threadCount: number }
export type ProviderHealth = { installed: boolean; version?: string }
export type Bootstrap = {
  threads: ThreadSummary[]
  projects: ProjectSummary[]
  providers: Record<Provider, ProviderHealth>
  defaultCwd: string
}
export const isActive = (status: Status) => ['starting', 'working', 'waiting'].includes(status)
