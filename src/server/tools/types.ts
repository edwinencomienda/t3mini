import type { z } from 'zod'
import type { Block } from '../../blocks'
import type { ProcessInfo } from '../processes'

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
  // Long-running processes (dev servers…) in this thread's project.
  processes: ProjectProcesses
  // Renames this thread (never another one) and returns the saved title.
  rename: (title: string) => Promise<string>
}

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
  summarize?: (input: z.infer<z.ZodObject<Shape>>) => string | undefined
  // Returns a short message for the agent. Throw ToolError for a clear refusal.
  run: (context: ToolContext, input: z.infer<z.ZodObject<Shape>>) => Promise<string>
}

export class ToolError extends Error {
  readonly name = 'ToolError'
}

export const defineTool = <Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>) => tool
