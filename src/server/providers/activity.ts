// Turns provider tool calls into readable work-log steps: a short label ("Run", "Read"), a
// one-line summary (the command or path), the full input for the expanded view, and output.
import { findClaudeTool, findTool } from '../tools'
import type { StepHints } from '../tools/types'

export type ToolStep = {
  label: string
  summary?: string
  detail?: string
  title?: string
  // A to-do list call, shown as the checklist card instead of a step.
  todo?: boolean
  // A browser tool call.
  browser?: boolean
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const string = (value: unknown) => (typeof value === 'string' ? value : '')

// Long output is cut so a noisy command can't bloat the saved thread or the page.
export function clip(text: string, max = 8000) {
  return text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text
}
const firstLine = (text: string, max = 160) => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}
// Paths inside the project are shown relative to it.
export const relativePath = (path: string, cwd: string) =>
  path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path

export function describeClaudeTool(
  name: string,
  rawInput: unknown,
  cwd: string,
  hints?: StepHints,
): ToolStep {
  const input = object(rawInput)
  const path = relativePath(string(input.file_path) || string(input.notebook_path), cwd)
  switch (name) {
    case 'Bash': {
      const command = string(input.command)
      const description = string(input.description)
      return {
        label: 'Run',
        summary: firstLine(command),
        detail: command,
        ...(description.trim() ? { title: firstLine(description) } : {}),
      }
    }
    case 'Read': {
      const offset = Number(input.offset) || 0
      const limit = Number(input.limit) || 0
      const range = offset || limit ? ` (lines ${offset || 1}–${offset + limit || '…'})` : ''
      return { label: 'Read', summary: path + range, detail: string(input.file_path) }
    }
    case 'Write':
      return {
        label: 'Write',
        summary: path,
        detail: clip(string(input.content), 4000),
      }
    case 'Edit':
      return {
        label: 'Edit',
        summary: path,
        detail: editPreview([{ old: input.old_string, new: input.new_string }]),
      }
    case 'MultiEdit':
      return {
        label: 'Edit',
        summary: path,
        detail: editPreview(
          (Array.isArray(input.edits) ? input.edits : []).map((edit) => ({
            old: object(edit).old_string,
            new: object(edit).new_string,
          })),
        ),
      }
    case 'NotebookEdit':
      return { label: 'Edit notebook', summary: path, detail: string(input.new_source) }
    case 'Glob':
      return {
        label: 'Find files',
        summary: string(input.pattern) + inPath(input.path, cwd),
      }
    case 'Grep':
      return {
        label: 'Search',
        summary: `"${string(input.pattern)}"${inPath(input.path, cwd)}${
          input.glob ? ` (${string(input.glob)})` : ''
        }`,
      }
    case 'WebFetch':
      return { label: 'Fetch', summary: string(input.url), detail: string(input.prompt) }
    case 'ToolSearch':
      // Claude loading tools it keeps on standby (e.g. its to-do tools) before using them.
      return {
        label: 'Load tools',
        summary:
          string(input.query)
            .replace(/^select:/, '')
            .split(',')
            .join(', ') || undefined,
      }
    case 'WebSearch':
      return { label: 'Search the web', summary: string(input.query) }
    case 'Task':
    case 'Agent':
      return {
        label: 'Agent',
        summary: string(input.description),
        detail: clip(string(input.prompt), 4000),
      }
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return { label: 'Update todos', summary: string(input.subject) || undefined, todo: true }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos.map(object) : []
      return {
        label: 'Update todos',
        todo: true,
        summary: `${todos.length} ${todos.length === 1 ? 'item' : 'items'}`,
        detail: todos
          .map(
            (todo) =>
              `${todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]'} ${string(todo.content)}`,
          )
          .join('\n'),
      }
    }
  }
  // t3 mini's own tools read like built-ins: "Show image · screen.png".
  const own = findClaudeTool(name)
  if (own) {
    // The input may still be empty: the step is shown as soon as Claude starts the call.
    let summary: string | undefined
    try {
      summary = own.summarize?.(input as never, hints)
    } catch {
      summary = undefined
    }
    return {
      label: own.label,
      summary,
      detail: json(rawInput),
      ...(own.kind === 'browser' ? { browser: true } : {}),
    }
  }
  // MCP tools are named mcp__<server>__<tool>.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return { label: mcp[2]!, summary: mcp[1], detail: json(rawInput) }
  return { label: name, detail: json(rawInput) }
}
const inPath = (path: unknown, cwd: string) =>
  string(path) ? ` in ${relativePath(string(path), cwd) || '.'}` : ''
const json = (value: unknown) => {
  const text = JSON.stringify(value, null, 2)
  return text && text !== '{}' ? clip(text, 4000) : undefined
}
function editPreview(edits: { old: unknown; new: unknown }[]) {
  const lines = (prefix: string, text: unknown) =>
    string(text)
      .split('\n')
      .map((line) => `${prefix} ${line}`)
      .join('\n')
  return clip(
    edits.map((edit) => `${lines('-', edit.old)}\n${lines('+', edit.new)}`).join('\n…\n'),
    4000,
  )
}

// A tool result's text (string or text blocks), for the expanded view.
export function toolOutput(content: unknown): string | undefined {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => {
              const item = object(block)
              return item.type === 'text'
                ? string(item.text)
                : item.type === 'image'
                  ? '[image]'
                  : ''
            })
            .filter(Boolean)
            .join('\n')
        : ''
  return text.trim() ? clip(text.trimEnd()) : undefined
}

// Codex runs commands through a shell wrapper; show the command itself.
export function unwrapShell(command: string) {
  const match = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim())
  return match ? match[2]! : command
}

export function describeCodexItem(
  item: Record<string, unknown>,
  cwd: string,
  hints?: StepHints,
): ToolStep & {
  output?: string
} {
  switch (string(item.type)) {
    case 'commandExecution': {
      const command = unwrapShell(string(item.command))
      const output = string(item.aggregatedOutput)
      const exit = typeof item.exitCode === 'number' && item.exitCode !== 0 ? item.exitCode : null
      return {
        label: 'Run',
        summary: firstLine(command),
        detail: command,
        output:
          output.trim() || exit !== null
            ? clip(`${output.trimEnd()}${exit !== null ? `\n[exit code ${exit}]` : ''}`.trim())
            : undefined,
      }
    }
    case 'fileChange': {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map(object)
      const paths = changes.map((change) => relativePath(string(change.path), cwd))
      return {
        label: 'Edit',
        summary:
          paths.slice(0, 2).join(', ') + (paths.length > 2 ? ` +${paths.length - 2} more` : ''),
        detail: clip(
          changes
            .map((change) => string(change.diff))
            .filter(Boolean)
            .join('\n'),
          6000,
        ),
      }
    }
    case 'webSearch':
      return { label: 'Search the web', summary: string(item.query) }
    case 'mcpToolCall':
      return {
        label: string(item.tool) || 'Use tool',
        summary: string(item.server),
        detail: json(item.arguments),
        output: item.result ? json(item.result) : undefined,
      }
    case 'dynamicToolCall': {
      // t3 mini's own tools read like built-ins: "Show image · envelope.png".
      const own = findTool(string(item.tool))
      let summary: string | undefined
      try {
        summary = own?.summarize?.(object(item.arguments) as never, hints)
      } catch {
        summary = undefined
      }
      return {
        label: own?.label ?? (string(item.tool) || 'Use tool'),
        summary,
        detail: json(item.arguments),
        ...(own?.kind === 'browser' ? { browser: true } : {}),
      }
    }
    case 'imageGeneration':
      return {
        label: 'Generate image',
        summary: string(item.revisedPrompt) ? firstLine(string(item.revisedPrompt)) : undefined,
        detail: string(item.revisedPrompt) || undefined,
      }
    case 'reasoning':
      return { label: 'Thinking' }
  }
  return { label: 'Use tool' }
}
