import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { pageLibraries, type PageLibrary } from '../../html-page'
import { maxHtmlBytes } from '../uploads'
import type { RenderedPage } from '../browser'
import { ToolError, defineTool } from './types'

// Shows a small HTML page in the chat: an interactive chart, a sortable table, a UI mockup, a
// calculator… The page is stored with the uploads and shown in a sealed sandbox (see
// src/components/HtmlView.tsx and src/html-page.ts): its own origin, no network, no popups,
// forms, or navigation. Before it's shown it's rendered once in a throwaway headless browser
// context, and the agent gets a screenshot and any errors back, so it can see what you see and
// fix it in place (same key).

const description = [
  'Show the user a small, self-contained HTML page inline in the chat, for what a picture or ' +
    'diagram can’t do: interactive charts, sortable tables, UI mockups, small calculators, ' +
    'visual explainers.',
  'Sandbox: one page with inline <style> and <script> (JavaScript works), NO network: no ' +
    'fetch, external scripts, stylesheets, fonts, or images (use inline SVG, CSS, or data: ' +
    'URLs; put data inline, e.g. as JSON in a <script>), no popups, forms, or navigation.',
  'Layout: it sits in the reply at its full width (about 736px; phones about 360px, so let ' +
    'it wrap) with no frame, on the chat’s own background, like part of the message. Write a ' +
    'fragment, not a full document. Don’t wrap it in an outer card, border, background, ' +
    'shadow, padding, or max-width, and don’t size anything to the window height (100vh); ' +
    'let it be as tall as it needs.',
  'Look: it already uses the app’s font (14px) and colors, and plain h1-h4, p, table, ' +
    'button (class="primary" for the main one), input, select, code, and kbd are styled to ' +
    'match, so write little CSS. Use the theme variables, never fixed colors (the page ' +
    'follows light/dark): --foreground, --muted-foreground, --faint, --background, --card, ' +
    '--muted, --accent, --border, --input, --primary, --primary-foreground, --success, ' +
    '--warning, --danger, --code-surface, --radius, --font-mono, and --chart-1 to --chart-6 ' +
    'for data series in that order. Use font-variant-numeric: tabular-nums for numbers and ' +
    'give interactive parts hover and focus states.',
  'Charts: pass libraries: ["chart.js"] to get Chart.js 4 (global Chart), already themed: ' +
    'text, grid, tooltips, and series colors follow the theme when you leave colors out. ' +
    'For explicit colors use t3.color("--chart-2") or t3.color("--chart-2", 0.2) (canvas ' +
    'can’t read CSS variables); t3.palette lists the series colors. Put each canvas in a ' +
    'div with a set height (e.g. 280px) and maintainAspectRatio: false.',
  'Checking: you get back a screenshot of the page as the user sees it, any script errors, ' +
    'and whether it overflows a phone screen. If something is wrong, call show_html again ' +
    'with the same key to replace the page in place (within this turn).',
  `Up to ${maxHtmlBytes / 1024} KB.`,
].join('\n')

export const showHtml = defineTool({
  name: 'show_html',
  label: 'Show HTML',
  description,
  input: {
    html: z
      .string()
      .min(1)
      .describe('The HTML fragment to show, with inline <style> and <script>.'),
    title: z.string().max(120).optional().describe('A short title shown under it.'),
    key: z
      .string()
      .regex(/^[\w.-]{1,40}$/)
      .optional()
      .describe(
        'Names this page within the turn, e.g. "sales-chart". Showing the same key again ' +
          'replaces the page instead of adding another.',
      ),
    libraries: z
      .array(z.enum(pageLibraries))
      .max(pageLibraries.length)
      .optional()
      .describe('Bundled libraries to load into the page: "chart.js" (Chart.js 4, global Chart).'),
  },
  safety: 'safe',
  summarize: (input) => input.title ?? input.key,
  async run(context, input) {
    // Said plainly, so the agent knows what to fix.
    if (!input.html.trim()) throw new ToolError('The HTML is empty.')
    if (Buffer.byteLength(input.html, 'utf8') > maxHtmlBytes)
      throw new ToolError(
        `The HTML is too large (limit ${maxHtmlBytes / 1024} KB). Make it smaller.`,
      )
    const libraries: PageLibrary[] = [...new Set(input.libraries ?? [])]
    // The render check is a help, not a gate: without a browser the page is still shown.
    let rendered: (RenderedPage & { theme: 'light' | 'dark' }) | undefined
    let unchecked = ''
    try {
      rendered = await context.renderHtml(input.html, libraries)
    } catch (error) {
      unchecked =
        error instanceof Error && error.name === 'BrowserError'
          ? ` It couldn’t be checked (${error.message})`
          : ' It couldn’t be checked.'
    }
    const { id } = await context.saveHtml(input.html)
    // Every page gets a key, so the agent can always replace it.
    const key = input.key ?? `page-${randomBytes(3).toString('hex')}`
    const change = context.showHtml({
      type: 'html',
      id,
      key,
      ...(input.title ? { title: input.title } : {}),
      ...(libraries.length ? { libraries } : {}),
    })
    const shown = `${change === 'replaced' ? 'Replaced the page' : 'Shown to the user'}${input.title ? `: ${input.title}` : ''}.`
    if (!rendered) return `${shown}${unchecked} Its key is "${key}".`
    return {
      text: renderReport(shown, rendered, key),
      image: { data: rendered.image, mimeType: 'image/png' },
    }
  },
})

// What the agent reads after the render check, with the screenshot.
export function renderReport(
  shown: string,
  page: RenderedPage & { theme: 'light' | 'dark' },
  key: string,
) {
  const lines = [
    shown,
    `Screenshot attached: ${page.width}×${page.height}px in the ${page.theme} theme, as it shows in the chat${page.height > 2400 ? ' (cut off at 2400px)' : ''}.`,
  ]
  if (page.height < 24) lines.push('The page is (nearly) empty: nothing visible was drawn.')
  if (page.errors.length)
    lines.push(`Errors in the page:\n${page.errors.map((error) => `- ${error}`).join('\n')}`)
  if (page.overflow > 4)
    lines.push(
      `On a phone (360px) it is ${page.overflow}px wider than the screen; let it wrap or shrink.`,
    )
  const problems = page.errors.length || page.overflow > 4 || page.height < 24
  lines.push(
    problems
      ? `Fix it: call show_html again with key "${key}" to replace this page.`
      : `Check the screenshot; if anything is off, call show_html again with key "${key}" to replace this page.`,
  )
  return lines.join('\n')
}
