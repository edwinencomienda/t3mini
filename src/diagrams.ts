// Mermaid diagrams, shared by the show_diagram tool (which checks the source before it's saved)
// and the client (which labels and draws it). Mermaid itself only runs in the browser.

export const maxDiagramSource = 20_000

// Mermaid's diagram types by their first keyword, with the name the card shows.
const kinds: [RegExp, string][] = [
  [/^(flowchart|graph)\b/, 'Flowchart'],
  [/^sequenceDiagram\b/, 'Sequence diagram'],
  [/^classDiagram(-v2)?\b/, 'Class diagram'],
  [/^stateDiagram(-v2)?\b/, 'State diagram'],
  [/^erDiagram\b/, 'Entity relationship diagram'],
  [/^journey\b/, 'User journey'],
  [/^gantt\b/, 'Gantt chart'],
  [/^pie\b/, 'Pie chart'],
  [/^quadrantChart\b/, 'Quadrant chart'],
  [/^requirementDiagram\b/, 'Requirement diagram'],
  [/^gitGraph\b/, 'Git graph'],
  [/^C4(Context|Container|Component|Dynamic|Deployment)\b/, 'C4 diagram'],
  [/^mindmap\b/, 'Mind map'],
  [/^timeline\b/, 'Timeline'],
  [/^sankey(-beta)?\b/, 'Sankey diagram'],
  [/^xychart(-beta)?\b/, 'XY chart'],
  [/^block(-beta)?\b/, 'Block diagram'],
  [/^packet(-beta)?\b/, 'Packet diagram'],
  [/^kanban\b/, 'Kanban board'],
  [/^architecture(-beta)?\b/, 'Architecture diagram'],
  [/^radar(-beta)?\b/, 'Radar chart'],
  [/^treemap(-beta)?\b/, 'Treemap'],
]
export const diagramTypes =
  'flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, journey, gantt, pie, ' +
  'quadrantChart, requirementDiagram, gitGraph, C4Context, mindmap, timeline, sankey-beta, ' +
  'xychart-beta, block-beta, packet-beta, kanban, architecture-beta, radar-beta, treemap-beta'

// The diagram's type name (e.g. "Flowchart"), or undefined if the source doesn't start with a
// Mermaid diagram keyword. Skips front matter (--- … ---), %% comments, and blank lines.
export function diagramKind(source: string): string | undefined {
  const lines = source.replace(/^﻿/, '').split(/\r?\n/)
  let index = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, at) => at > 0 && line.trim() === '---')
    if (end < 0) return undefined
    index = end + 1
  }
  for (; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (!line || line.startsWith('%%')) continue
    return kinds.find(([pattern]) => pattern.test(line))?.[1]
  }
  return undefined
}

// A left-to-right (or right-to-left) flowchart laid out top to bottom instead: the same
// diagram, for when it's too wide to read at the reply's width. Null for anything else.
export function verticalFlowchart(source: string): string | null {
  const declaration = /^(\s*(?:flowchart|graph))[ \t]+(?:LR|RL)\b/m
  return declaration.test(source) ? source.replace(declaration, '$1 TB') : null
}
