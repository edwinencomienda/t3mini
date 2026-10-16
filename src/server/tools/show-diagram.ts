import { z } from 'zod'
import { diagramKind, diagramTypes, maxDiagramSource } from '../../diagrams'
import { defineTool, ToolError } from './types'

// Shows a Mermaid diagram (flowchart, sequence, ER, state, class, Gantt, mind map…) in the
// chat. Only the source is saved; the browser draws it, in the current theme, with Mermaid's
// strict security level and the result sanitized (see components/Diagram.tsx).
export const showDiagram = defineTool({
  name: 'show_diagram',
  label: 'Show diagram',
  description:
    'Show a diagram to the user inline in the chat, drawn from Mermaid source. Use it whenever a ' +
    'picture explains better than text: architecture and data flow, request/sequence flows, ' +
    'state machines, database schemas (erDiagram), class structure, timelines, plans (gantt), ' +
    'mind maps, or git branching. Write plain Mermaid, without ``` fences. Prefer `flowchart` ' +
    'over `graph`, keep node labels short, quote labels with special characters ' +
    '(A["Login (OAuth)"]), and avoid custom colors, styles, and %%{init}%% directives: t3 mini ' +
    `themes the diagram for light and dark mode. Supported types: ${diagramTypes}. ` +
    'The user sees the diagram right away; refer to it in your reply instead of repeating it.',
  input: {
    source: z
      .string()
      .min(1)
      .max(maxDiagramSource)
      .describe('The Mermaid diagram source, starting with its type, e.g. "flowchart LR".'),
    title: z
      .string()
      .max(120)
      .optional()
      .describe('Optional short title shown above the diagram, e.g. "Login flow".'),
  },
  safety: 'safe',
  summarize: (input) => input.title || (input.source ? diagramKind(input.source) : undefined),
  async run(context, input) {
    const source = input.source
      .trim()
      // Agents sometimes wrap it in a Markdown fence anyway.
      .replace(/^```(?:mermaid)?[^\n]*\n([\s\S]*?)\n?```$/, '$1')
      .trim()
    const kind = diagramKind(source)
    if (!kind)
      throw new ToolError(
        `That doesn't look like Mermaid: start with a diagram type (${diagramTypes}).`,
      )
    const title = input.title?.trim()
    context.attach({ type: 'diagram', source, ...(title ? { title } : {}) })
    return (
      `Shown to the user: ${title ? `"${title}" (${kind.toLowerCase()})` : kind.toLowerCase()}. ` +
      'It is drawn in their browser; if it has a syntax error they see the error, so make sure ' +
      'the Mermaid is valid.'
    )
  },
})
