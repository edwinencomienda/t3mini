import { z } from 'zod'
import { permissionModes } from '../agent-settings'

// View settings shared by every browser, profile, and window (stored in .data/ui.json, sent
// with live updates). Each field is checked here, both when a browser changes it and when the
// file is read back, so a bad value never reaches a page.

const text = (max: number) => z.string().max(max)
const agentSettings = z.object({
  model: text(200),
  effort: text(50),
  permissionMode: z.enum(permissionModes.map((mode) => mode.value) as [string, ...string[]]),
  serviceTier: text(50).optional(),
})
export const uiFields = {
  groupBy: z.enum(['project', 'none', 'date']),
  theme: z.enum(['system', 'light', 'dark']),
  projectIcons: z.boolean(),
  animations: z.boolean(),
  // The agent and settings new threads start with (your last choices).
  agent: z.object({
    provider: z.enum(['claude', 'codex']).optional(),
    cwd: text(4096).optional(),
    settings: z.object({ claude: agentSettings.optional(), codex: agentSettings.optional() }),
  }),
  // The agents' browser may open public websites too (read-only there; see browser.ts). Off
  // unless turned on in Settings → Agents.
  browserPublic: z.boolean(),
  // Projects collapsed in the sidebar.
  collapsed: z
    .record(text(4096), z.boolean())
    .refine((value) => Object.keys(value).length <= 500, 'Too many projects.'),
  music: z.object({
    enabled: z.boolean(),
    url: text(500),
    volume: z.number().int().min(0).max(100),
  }),
  // Where the background music was; saved often, so it isn't broadcast (see updateUi).
  musicPosition: z.object({
    source: text(200),
    time: z.number().min(0).max(1e7),
    index: z.number().int().min(0).max(10_000).optional(),
  }),
}
export const uiChange = z.object(uiFields).partial().strict()

// Reads a saved file, keeping each valid field and dropping the rest.
export function readUiSettings(saved: unknown) {
  const settings: Record<string, unknown> = { groupBy: 'project' }
  if (saved && typeof saved === 'object')
    for (const [key, schema] of Object.entries(uiFields)) {
      const parsed = schema.safeParse((saved as Record<string, unknown>)[key])
      if (parsed.success) settings[key] = parsed.data
    }
  return settings
}
