import type { PermissionMode } from './agent-settings'
import type { Block } from './blocks'

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
  // Content added by tools during the reply (images now; charts and more later).
  blocks?: Block[]
  // Sent while the agent was working and waiting to go out as the next turn.
  queued?: boolean
  // Queued, but the turn was stopped before it could be sent.
  unsent?: boolean
  // Set on a message that started a turn: how to take that turn back out of the agent's
  // memory, so the message can be edited and resent after a stop or failure.
  turn?: TurnCheckpoint
  // An edit that couldn't rewind the agent, so it went out as a follow-up instead.
  rewindFailed?: boolean
}
export type TurnCheckpoint = {
  // Claude: the turn was the session's first (an edit starts a new session), or the last
  // conversation entry before it (resumeSessionAt) and this prompt's id (resumeDropsTurn).
  fresh?: boolean
  claudeResumeAt?: string
  claudePrompt?: string
  // Codex: the turn's id (thread/revert drops it and everything after).
  codexTurn?: string
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
  // The subagent that took this step (its task description); absent for the main agent.
  agent?: string
}
// A multiple-choice question from the agent (Claude's AskUserQuestion).
export type QuestionOption = { label: string; description?: string }
export type Question = {
  question: string
  // A short tag, e.g. "Auth method".
  header?: string
  multiSelect?: boolean
  options: QuestionOption[]
}
// Something the agent is waiting on: a yes/no permission, or (with `questions`) answers.
export type Approval = { id: string; title: string; detail: string; questions?: Question[] }
// A task the agent left running in the background (e.g. a subagent), while the turn is open.
export type BackgroundTask = { id: string; description: string }
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
  // Claude: the session's latest conversation entry, where a later rewind can resume from.
  claudeEntry?: string
  // A turn to drop from the agent's memory before the next run (set by an edit).
  rewind?: TurnCheckpoint
  // Background tasks still running in the current turn.
  background?: BackgroundTask[]
  // Where the title came from: your first message (replaced by an AI title once there is one),
  // an AI, or a rename by you or the agent (never replaced automatically).
  titleSource?: 'message' | 'ai' | 'custom'
}
export type ThreadSummary = Pick<
  Thread,
  'id' | 'title' | 'provider' | 'cwd' | 'status' | 'updatedAt'
> & {
  // When you last sent a message (or created the thread). The sidebar sorts by this, so
  // streaming agents don't keep reshuffling the list.
  lastMessageAt: string
  // While waiting: on a yes/no approval, or on answers to the agent's question.
  waitingFor?: 'approval' | 'question'
}
// A project is a folder on this machine. Saved projects stay in the sidebar even without threads.
// name: shown instead of the folder name; renaming never touches the folder on disk.
export type Project = { path: string; addedAt: string; name?: string }
export type ProjectSummary = {
  path: string
  name?: string
  lastActiveAt: string
  threadCount: number
}
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
  // A Deepgram key is configured, so the composer can offer dictation.
  dictation?: boolean
  defaultCwd: string
}
// A thread project's git state for the composer. detached: branch is a short commit hash.
// url: the branch (or repository) on GitHub, when the remote is there.
export type GitInfo = { branch: string | null; detached?: boolean; url?: string }
// The message that can be edited and resent: the last thing you sent, when its turn was stopped
// or failed and the agent can take that turn back (see TurnCheckpoint).
export function editableMessage(thread: Pick<Thread, 'status' | 'provider' | 'messages'>) {
  if (thread.status !== 'interrupted' && thread.status !== 'failed') return undefined
  const last = [...thread.messages].reverse().find((message) => message.role === 'user')
  const turn = last?.turn
  if (!turn) return undefined
  const undoable =
    thread.provider === 'claude'
      ? turn.fresh || Boolean(turn.claudeResumeAt)
      : Boolean(turn.codexTurn)
  return undoable ? last : undefined
}
export const isActive = (status: Status) => ['starting', 'working', 'waiting'].includes(status)
