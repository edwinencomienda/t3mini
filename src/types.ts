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
  // Sent while the agent was waiting on its question, so it answered that question.
  answered?: boolean
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
  // A plain-English headline when the agent gave one (Claude's description of a command),
  // shown instead of the label and summary.
  title?: string
  // When the step started (steps saved before this was added have none), to place it among
  // the agent's messages and time it.
  startedAt?: string
  // A to-do list update: drawn as the checklist card instead of a step.
  todo?: boolean
  // A browser tool step (browser_*): shown with a globe.
  browser?: boolean
  // The agent compacting the conversation (its context got long): shown as a divider with how
  // much it shrank. Token counts and timing when the agent reports them (Claude does).
  compact?: {
    trigger?: 'auto' | 'manual'
    before?: number
    after?: number
    ms?: number
    error?: string
  }
  // Full input for the expanded view (whole command, edit preview, arguments).
  detail?: string
  // What the step returned, trimmed.
  output?: string
  status: 'running' | 'completed' | 'failed'
  // The subagent that took this step (its task description); absent for the main agent.
  agent?: string
}
// One item of the agent's to-do checklist. activeText is the "-ing" form shown while it's the
// current item ("Running tests").
export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type Todo = { id: string; text: string; activeText?: string; status: TodoStatus }
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
  // The agent's latest to-do checklist (kept across turns: Claude's tasks live for the session).
  todos?: Todo[]
  // Finished or failed while nobody was looking at it (cleared when opened anywhere).
  unread?: boolean
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
  // Finished or failed while nobody was looking (shared by every browser and device).
  unread?: boolean
}
// A quick look at a thread for the sidebar's hover card: its settings, size, and the start and
// latest reply of the conversation (shortened).
export type ThreadGlance = Pick<
  Thread,
  | 'id'
  | 'title'
  | 'provider'
  | 'cwd'
  | 'model'
  | 'effort'
  | 'permissionMode'
  | 'serviceTier'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'error'
> & {
  messageCount: number
  firstMessage?: string
  lastReply?: string
  // What it waits for, e.g. the approval's title.
  waitingOn?: string
}
// A thread's open browser page (the browser_* tools), for the composer's browser chip.
export type BrowserInfo = { threadId: string; url: string; title: string; tabs: number }
// A conversation that mentions what you searched for (command palette), with a short excerpt.
export type MessageMatch = {
  threadId: string
  title: string
  cwd: string
  role: 'user' | 'assistant'
  snippet: string
}
// A project is a folder on this machine. Saved projects stay in the sidebar even without threads.
// name: shown instead of the folder name; renaming never touches the folder on disk.
// lastActiveAt: your latest message in a thread you've since deleted, so deleting threads
// doesn't move the project down the sidebar.
// avatar: how its sidebar avatar is picked (absent: its own icon if it has one, else its
// letter); image: an uploaded image's id, for avatar 'image'.
export type ProjectAvatarKind = 'letter' | 'image'
export type Project = {
  path: string
  addedAt: string
  name?: string
  lastActiveAt?: string
  avatar?: ProjectAvatarKind
  image?: string
}
export type ProjectSummary = {
  path: string
  name?: string
  lastActiveAt: string
  // When it was added (or, for a folder that only has threads, its first thread): the
  // sidebar keeps projects in this order so they don't jump around with activity.
  addedAt: string
  threadCount: number
  // It has its own icon (a favicon or app icon), served at /api/projects/icon?path=…
  icon?: boolean
  // Chosen in Project settings (see Project).
  avatar?: ProjectAvatarKind
  image?: string
}
export type ProviderHealth = { installed: boolean; version?: string }
// View settings shared by every browser and window (kept on the server, sent with live
// updates), unlike per-browser ones such as the theme.
export type UiSettings = {
  groupBy: 'project' | 'none'
  theme?: 'system' | 'light' | 'dark'
  projectIcons?: boolean
  // Working animations (the agent characters).
  animations?: boolean
  // The agent and settings new threads start with.
  agent?: {
    provider?: Provider
    cwd?: string
    settings: Partial<Record<Provider, import('./agent-settings').AgentSettings>>
  }
  collapsed?: Record<string, boolean>
  music?: { enabled: boolean; url: string; volume: number }
  musicPosition?: { source: string; time: number; index?: number }
}
export type Bootstrap = {
  ui?: UiSettings
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
export type GitInfo = {
  branch: string | null
  detached?: boolean
  url?: string
  // The branch's pull request on GitHub, when it has one (looked up separately; see service).
  pullRequest?: PullRequest | null
}
export type PullRequest = { number: number; url: string }
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
