import type { Activity, Approval, Thread } from '../../types'
export type ProviderContext = {
  thread: Thread
  prompt: string
  signal: AbortSignal
  session: (id: string) => void
  text: (id: string, text: string, replace?: boolean) => void
  activity: (activity: Activity) => void
  approve: (approval: Approval) => Promise<boolean>
}
export type Runner = (context: ProviderContext) => Promise<void>
