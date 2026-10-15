import type { Activity, Approval, Thread } from '../../types'
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
  // What t3 mini tools (show_image…) use to act on this thread.
  tools: ToolContext
  // Providers that support steering register a handler once the run can accept messages.
  onSteer?: (handler: Steer) => void
}
export type Runner = (context: ProviderContext) => Promise<void>
