import { z } from 'zod'
import { maxHtmlBytes } from '../uploads'
import { ToolError, defineTool } from './types'

// Shows a small HTML page in the chat: an interactive chart, a sortable table, a UI mockup, a
// calculator… The page is stored with the uploads and shown in a sealed sandbox (see
// src/components/HtmlView.tsx): its own origin, no network, no popups, forms, or navigation.
export const showHtml = defineTool({
  name: 'show_html',
  label: 'Show HTML',
  description:
    'Show the user a small, self-contained HTML page inline in the chat, for things a picture ' +
    'or diagram can’t do: interactive charts, sortable tables, UI mockups, small calculators, ' +
    'visual explainers. Write one complete page with inline <style> and <script> (JavaScript ' +
    'works). It runs in a sealed sandbox with NO network: no fetch, no external scripts, ' +
    'stylesheets, fonts, or images (use inline SVG, CSS, or data: URLs), and no popups, ' +
    'forms, or navigation. Theme colors are available as CSS variables (--background, ' +
    '--foreground, --muted, --muted-foreground, --border, --primary, --card) and the page ' +
    'follows light/dark mode, so prefer them over fixed colors. It is shown at the full width ' +
    'of the reply with no frame, on the chat’s own background, like part of the message: ' +
    'don’t wrap the page in an outer card, border, background, shadow, padding, or max-width, ' +
    'and don’t size anything to the window height (100vh); let the content fill the width ' +
    `and be as tall as it needs. Up to ${maxHtmlBytes / 1024} KB.`,
  input: {
    html: z
      .string()
      .min(1)
      .describe('The complete HTML document (or fragment) to show, with inline CSS and JS.'),
    title: z.string().max(120).optional().describe('A short title shown above it.'),
  },
  safety: 'safe',
  summarize: (input) => input.title,
  async run(context, input) {
    // Said plainly, so the agent knows what to fix.
    if (!input.html.trim()) throw new ToolError('The HTML is empty.')
    if (Buffer.byteLength(input.html, 'utf8') > maxHtmlBytes)
      throw new ToolError(
        `The HTML is too large (limit ${maxHtmlBytes / 1024} KB). Make it smaller.`,
      )
    const { id } = await context.saveHtml(input.html)
    context.attach({ type: 'html', id, ...(input.title ? { title: input.title } : {}) })
    return `Shown to the user${input.title ? `: ${input.title}` : ''}.`
  },
})
