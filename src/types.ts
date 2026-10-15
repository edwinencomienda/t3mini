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
  // Sent while the agent was working and waiting to go out as the next turn.
  queued?: boolean
  // Queued, but the turn was stopped before it could be sent.
  unsent?: boolean
}
export type Activity = {
  id: string
  // Short verb or tool name, e.g. "Run", "Read", "Edit".
  label: string
  // One line: the command, path, or query.
  summary?: string
  // Full input for the expanded view (whole command, edit preview, arguments).
  detail?: string
  // What the step returned, trimmed.
  output?: string
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
  serviceTier?: string
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
  // Editors found on this machine that a project can be opened in.
  editors: { vscode: boolean }
  // Set by the API: this page is on a paired phone; and whether phone access is switched on.
  remote?: boolean
  phoneAccess?: boolean
  defaultCwd: string
}
export const isActive = (status: Status) => ['starting', 'working', 'waiting'].includes(status)
