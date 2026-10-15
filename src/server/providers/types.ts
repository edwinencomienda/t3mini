import type { Activity, Approval, Thread } from '../../types'
// Images attached to this turn, saved on disk.
export type PromptImage = { path: string; mimeType: string }
export type ProviderContext = {
  thread: Thread
  prompt: string
  images: PromptImage[]
  signal: AbortSignal
  session: (id: string) => void
  text: (id: string, text: string, replace?: boolean) => void
  activity: (activity: Activity) => void
  approve: (approval: Approval) => Promise<boolean>
}
export type Runner = (context: ProviderContext) => Promise<void>
