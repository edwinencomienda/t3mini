import type {
  Activity,
  Approval,
  BackgroundTask,
  Question,
  Thread,
  TurnCheckpoint,
} from '../../types'
import type { ToolContext } from '../tools/types'
// Images attached to this turn, saved on disk.
export type PromptImage = { path: string; mimeType: string }
// A message sent while the turn runs. The handler resolves true if the provider took it into
// the live run, false if it can't (the service then queues it as the next turn).
export type Steer = (input: { prompt: string; images: PromptImage[] }) => Promise<boolean>
export type ProviderContext = {
  thread: Thread
  prompt: string
  images: PromptImage[]
  signal: AbortSignal
  session: (id: string) => void
  text: (id: string, text: string, replace?: boolean) => void
  activity: (activity: Activity) => void
  approve: (approval: Approval) => Promise<boolean>
  // A question for you; resolves with your answers (question text → answer), or null if you
  // skipped it.
  ask?: (question: {
    id: string
    title: string
    questions: Question[]
  }) => Promise<Record<string, string> | null>
  // The tasks the agent currently has running in the background.
  background?: (tasks: BackgroundTask[]) => void
  // What t3 mini tools (show_image…) use to act on this thread.
  tools: ToolContext
  // Providers that support steering register a handler once the run can accept messages.
  onSteer?: (handler: Steer) => void
  // The id to give this turn's prompt (Claude), so the turn can be dropped later.
  promptId?: string
  // A turn to drop from the agent's memory before this one runs (an edited message).
  rewind?: TurnCheckpoint
  // Whether the rewind happened; false means the agent kept the old turn.
  rewound?: (ok: boolean) => void
  // Claude: each new conversation entry, the latest being where a later rewind resumes.
  entry?: (id: string) => void
  // Codex: this turn's id.
  turnStarted?: (turnId: string) => void
}
// Claude refuses a rewind when the dropped range holds something unexpected (e.g. a message
// it absorbed mid-turn). That's deterministic, so the turn is retried without rewinding.
export const rewindRefused = 'Resume rejected by --resume-drops-turn:'
export type Runner = (context: ProviderContext) => Promise<void>
