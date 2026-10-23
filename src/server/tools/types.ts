import type { z } from 'zod'
import type { Block } from '../../blocks'
import type { Page } from 'playwright-core'
import type { ProcessInfo } from '../processes'
import type { Provider, Question, Todo } from '../../types'

// A thread's own browser session (see ../browser.ts): one private page, local sites only.
export type ThreadBrowser = {
  // The page, opening the browser if needed.
  page: () => Promise<Page>
  // Why a page can't be opened (local sites, or public ones when allowed), or undefined.
  checkUrl: (url: string) => Promise<string | undefined>
  // The page if it's already open (the active tab).
  openPage: () => Promise<Page | undefined>
  // Tabs: open another (made active), list, switch to, or close one.
  newTab: () => Promise<Page>
  tabs: () => Promise<{ id: string; url: string; title: string; active: boolean }[]>
  switchTab: (id: string) => Promise<Page>
  closeTab: (id: string) => Promise<void>
  // Errors, failed requests, dialogs, and blocked addresses since the last look.
  takeLog: () => Promise<{ kind: string; text: string }[]>
  close: () => Promise<void>
  // Remembers what the refs in a page snapshot (e12…) point to, for readable step names.
  recordSnapshot: (snapshot: string) => void
  // "button 'Save'" for a ref from the latest snapshot.
  refName: (ref: string) => string | undefined
}
// What a lead thread may do with helper threads (only its own). Each refuses with a ToolError.
export type ThreadControl = {
  start: (input: {
    task: string
    title?: string
    agent?: 'claude' | 'codex'
  }) => Promise<{ id: string; title: string; agent: string; worktree: boolean }>
  message: (reference: string, text: string) => Promise<string>
  list: () => string
  stop: (reference: string) => Promise<string>
  remove: (reference: string) => Promise<string>
}
// What step summaries may look up while the call is still in progress.
export type StepHints = { refName?: (ref: string) => string | undefined }

// A thread's view of the process manager: only its own project's processes.
export type ProjectProcesses = {
  list: () => ProcessInfo[]
  start: (input: { name: string; command: string; cwd?: string }) => Promise<ProcessInfo>
  logs: (id: string, lines?: number) => string
  stop: (id: string) => Promise<ProcessInfo>
  restart: (id: string) => Promise<ProcessInfo>
}

// The t3 mini tool system. A tool is one definition: a name, a description the agent reads, a
// zod input shape (validation and the agent-facing schema in one), and a run() that works
// through a ToolContext. Provider adapters (Claude now, Codex later) turn the registry into
// whatever the agent understands; tools never know which agent called them.

export type ToolContext = {
  // The thread's project folder; tools that read files stay inside it (see paths.ts).
  cwd: string
  // Adds rich content (an image, later a chart…) to the agent's current reply.
  attach: (block: Block) => void
  // Stores image bytes with the thread's uploads and returns the id to reference.
  saveImage: (bytes: Buffer) => Promise<{ id: string }>
  // Stores an HTML page for show_html and returns the id to reference.
  saveHtml: (html: string) => Promise<{ id: string }>
  // Copies a video or sound file (an allowed path) into the uploads, checking its format.
  saveMedia: (file: string, kind: 'video' | 'audio') => Promise<{ id: string }>
  // Long-running processes (dev servers…) in this thread's project.
  processes: ProjectProcesses
  // Another thread as text, by its link or id, only if the user shared it in this thread
  // (read_thread). before: show turns before this turn number.
  readThread: (reference: string, before?: number) => Promise<string>
  // Renames this thread (never another one) and returns the saved title.
  rename: (title: string) => Promise<string>
  // Helper threads this thread started (orchestration tools in threads.ts).
  threads: ThreadControl
  // This thread's browser (browser_* tools).
  browser: ThreadBrowser
  // Shows questions on the question card and waits for the answers (question → answer), or
  // null if the user skipped them (ask_user).
  ask: (input: { title: string; questions: Question[] }) => Promise<Record<string, string> | null>
  // Replaces this thread's to-do checklist (update_checklist); an empty list clears it.
  setTodos: (todos: Todo[]) => void
}
// What a tool returns: text for the agent, optionally with an image it can look at (a
// browser screenshot). The image goes to the agent only; showing it in the chat is attach().
export type ToolResult = string | { text: string; image?: { data: Buffer; mimeType: string } }

export type ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> = {
  name: string
  // Shown in the work log, e.g. "Show image".
  label: string
  description: string
  input: Shape
  // 'safe' tools only display things and run without asking. Anything that changes files or
  // reaches the network should be 'approval' and go through Allow once / Decline.
  safety: 'safe' | 'approval'
  // The work-log summary for a call, e.g. the file name.
  summarize?: (input: z.infer<z.ZodObject<Shape>>, hints?: StepHints) => string | undefined
  // Browser tools are marked in the work log (a globe) and the live line; to-do tools are
  // drawn as the checklist card instead of a step.
  kind?: 'browser' | 'todo'
  // Inputs never shown in the work log or approval prompts (e.g. a login cookie's value).
  secretInputs?: string[]
  // Only these agents get the tool (default: both), e.g. one that stands in for a built-in
  // tool the other agent already has.
  providers?: Provider[]
  // Returns a short message for the agent. Throw ToolError for a clear refusal.
  run: (context: ToolContext, input: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>
}

export class ToolError extends Error {
  readonly name = 'ToolError'
}

export const defineTool = <Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>) => tool
