import type { z } from 'zod'
import type { Block } from '../../blocks'
import type { Page } from 'playwright-core'
import type { ProcessInfo } from '../processes'

// A thread's own browser session (see ../browser.ts): one private page, local sites only.
export type ThreadBrowser = {
  // The page, opening the browser if needed.
  page: () => Promise<Page>
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
  // Long-running processes (dev servers…) in this thread's project.
  processes: ProjectProcesses
  // Renames this thread (never another one) and returns the saved title.
  rename: (title: string) => Promise<string>
  // This thread's browser (browser_* tools).
  browser: ThreadBrowser
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
  // Browser tools are marked in the work log (a globe) and the live line.
  kind?: 'browser'
  // Inputs never shown in the work log or approval prompts (e.g. a login cookie's value).
  secretInputs?: string[]
  // Returns a short message for the agent. Throw ToolError for a clear refusal.
  run: (context: ToolContext, input: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>
}

export class ToolError extends Error {
  readonly name = 'ToolError'
}

export const defineTool = <Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>) => tool
