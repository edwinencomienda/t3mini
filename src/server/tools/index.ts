import { z } from 'zod'
import { showImage } from './show-image'
import { showDiagram } from './show-diagram'
import { processTools } from './processes'
import { renameThread } from './rename-thread'
import { browserTools } from './browser'
import { ToolError, type ToolContext, type ToolDefinition } from './types'

// Every tool agents can use. Add new tools here (one file each in this folder).
export const tools: ToolDefinition<any>[] = [
  showImage,
  showDiagram,
  renameThread,
  ...processTools,
  ...browserTools,
]

// Tools reach Claude through an in-process MCP server named "t3mini", so Claude sees them as
// mcp__t3mini__<name>.
export const mcpServerName = 't3mini'
export const claudeToolName = (name: string) => `mcp__${mcpServerName}__${name}`
export const findTool = (name: string) => tools.find((tool) => tool.name === name)
// A tool's input as shown to people (work log, approval prompts): secret inputs hidden.
export function maskInput(definition: ToolDefinition<any> | undefined, input: unknown) {
  if (!definition?.secretInputs?.length || !input || typeof input !== 'object') return input
  const shown: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  for (const key of definition.secretInputs) if (key in shown) shown[key] = '••••••'
  return shown
}
// Runs a tool for any agent: validates the input against the tool's schema, runs it, and turns
// failures into a message the agent can read. Never throws.
export async function runTool(
  definition: ToolDefinition<any>,
  context: ToolContext,
  rawInput: unknown,
): Promise<{ ok: boolean; text: string; image?: { data: string; mimeType: string } }> {
  const input = z.object(definition.input).safeParse(rawInput ?? {})
  if (!input.success)
    return {
      ok: false,
      text: `Invalid input for ${definition.name}: ${input.error.issues.map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`,
    }
  try {
    const result = await definition.run(context, input.data)
    if (typeof result === 'string') return { ok: true, text: result }
    return {
      ok: true,
      text: result.text,
      ...(result.image
        ? { image: { data: result.image.data.toString('base64'), mimeType: result.image.mimeType } }
        : {}),
    }
  } catch (error) {
    return {
      ok: false,
      text: error instanceof ToolError ? error.message : `${definition.label} failed.`,
    }
  }
}
// Each tool's input as JSON Schema, for agents that take tool definitions that way (Codex).
export function toolJsonSchema(definition: ToolDefinition<any>) {
  // Drop the "$schema" header: agents want the plain object schema.
  const { $schema: _version, ...schema } = z.toJSONSchema(z.object(definition.input)) as Record<
    string,
    unknown
  >
  return schema
}
export const findClaudeTool = (claudeName: string) =>
  tools.find((tool) => claudeToolName(tool.name) === claudeName)
