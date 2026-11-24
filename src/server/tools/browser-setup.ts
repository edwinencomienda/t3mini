import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { resolveAllowedFile } from './paths'
import { ToolError } from './types'

// Test setup for the agent's browser (browser_set_cookie's valueFrom, browser_mock): reading a
// value from a project file without it passing through the conversation, and checking faked
// responses. Everything stays inside the thread's private browser and local sites.

const maxValueBytes = 64 * 1024
export const maxMockBody = 256 * 1024

// A value read from a file in the project instead of written out (a test session token kept in
// a git-ignored file), so it never passes through the conversation.
export const valueFromSchema = z
  .object({
    file: z
      .string()
      .min(1)
      .max(500)
      .describe('A file in the project, e.g. ".fixtures/session.json" or ".env.local".'),
    key: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Which value: a JSON key (dots for nested keys, e.g. "host.token") or an env file ' +
          'variable name. Without it, the whole file (one line).',
      ),
  })
  .strict()
export type ValueFrom = z.infer<typeof valueFromSchema>

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export const mockInput = {
  url: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'Which requests: a path like "/api/me" or "/api/sessions/*" (any local site), or a full ' +
        'local URL like "http://localhost:3000/api/**". * matches within one path part, ** ' +
        'matches anything.',
    ),
  method: z.enum(methods).optional().describe('Only this method (default: any).'),
  status: z.number().int().min(100).max(599).optional().describe('The status (default 200).'),
  json: z.unknown().optional().describe('A JSON body (sent as application/json).'),
  body: z.string().max(maxMockBody).optional().describe('A text body, instead of json.'),
  contentType: z
    .string()
    .max(200)
    .optional()
    .describe('The content type (default: application/json for json, else text/plain).'),
}
const mockSchema = z.object(mockInput).strict()
export type MockInput = z.infer<typeof mockSchema>

// Reads a value from a project file (valueFrom). Errors name the file and key, never what's in
// the file. JSON files are read by key path; other files as KEY=value lines (.env style).
export async function readValueFrom(cwd: string, source: ValueFrom): Promise<string> {
  const path = await resolveAllowedFile(cwd, source.file, maxValueBytes, { projectOnly: true })
  const text = await readFile(path, 'utf8')
  const missing = () =>
    new ToolError(`There’s no value for "${source.key}" in ${source.file} (a string or number).`)
  if (!source.key) {
    const whole = text.trim()
    if (!whole || /[\r\n]/.test(whole))
      throw new ToolError(`${source.file} isn’t a single line. Pass key to pick a value from it.`)
    return whole
  }
  const json = /\.json$/i.test(source.file) || /^\s*[{[]/.test(text)
  if (json) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new ToolError(`${source.file} isn’t valid JSON.`)
    }
    for (const part of source.key.split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw missing()
      value = (value as Record<string, unknown>)[part]
    }
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    throw missing()
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match?.[1] !== source.key) continue
    const value = match[2]!
    const quoted = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(value)
    return quoted ? quoted[2]! : value.replace(/\s+#.*$/, '')
  }
  throw missing()
}

// A mock as the browser keeps it, from browser_mock's input. Refuses URLs that
// aren't local sites (public pages always get real responses) or that are t3 mini itself.
export async function toMock(
  input: MockInput,
  checkUrl: (url: string) => Promise<string | undefined>,
  isLocal: (url: string) => boolean,
) {
  if (input.json !== undefined && input.body !== undefined)
    throw new ToolError('Give either json or body, not both.')
  if (!input.url.startsWith('/')) {
    if (/^[a-z]+:\/\/[^/]*\*/i.test(input.url))
      throw new ToolError(
        'Name the site in a full URL (no * in the address), or use a path like /api/me.',
      )
    const sample = input.url.replace(/\*+/g, 'x')
    const refusal = await checkUrl(sample)
    if (refusal || !isLocal(sample))
      throw new ToolError(
        `Mocks only work for local sites (a path like /api/me, or a localhost URL). ${refusal ?? ''}`.trim(),
      )
  }
  const json = input.json !== undefined
  const body = json ? JSON.stringify(input.json) : (input.body ?? '')
  if (Buffer.byteLength(body) > maxMockBody)
    throw new ToolError(`The body is too large (limit ${maxMockBody / 1024} KB).`)
  return {
    url: input.url,
    ...(input.method ? { method: input.method } : {}),
    status: input.status ?? 200,
    contentType: input.contentType ?? (json ? 'application/json' : 'text/plain; charset=utf-8'),
    body,
  }
}
