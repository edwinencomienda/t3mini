import { expect, it, vi } from 'vitest'
import { diagramKind } from '../../diagrams'
import type { Block } from '../../blocks'
import { runTool } from './index'
import { showDiagram } from './show-diagram'
import type { ToolContext } from './types'

const context = () => {
  const attach = vi.fn<(block: Block) => void>()
  const value: ToolContext = {
    cwd: '/project',
    attach,
    saveImage: vi.fn(),
    processes: {} as never,
    browser: {} as never,
    rename: vi.fn(),
  }
  return { attach, value }
}

it('names Mermaid diagram types, skipping front matter and comments', () => {
  expect(diagramKind('flowchart LR\n  A --> B')).toBe('Flowchart')
  expect(diagramKind('graph TD\n  A --> B')).toBe('Flowchart')
  expect(diagramKind('%% the plan\n\nsequenceDiagram\n  A->>B: hi')).toBe('Sequence diagram')
  expect(diagramKind('---\ntitle: Schema\n---\nerDiagram\n  A ||--o{ B : has')).toBe(
    'Entity relationship diagram',
  )
  expect(diagramKind('stateDiagram-v2\n  [*] --> a')).toBe('State diagram')
  expect(diagramKind('xychart-beta\n  x-axis [a, b]')).toBe('XY chart')
  expect(diagramKind('Here is a diagram:\nflowchart LR')).toBeUndefined()
  expect(diagramKind('---\ntitle: never closed\nflowchart LR')).toBeUndefined()
  expect(diagramKind('graphql schema')).toBeUndefined()
})

it('shows a diagram with its title', async () => {
  const { attach, value } = context()
  const result = await runTool(showDiagram, value, {
    source: '  flowchart LR\n  A --> B\n',
    title: ' Login flow ',
  })
  expect(result).toMatchObject({ ok: true, text: expect.stringContaining('"Login flow"') })
  expect(attach).toHaveBeenCalledWith({
    type: 'diagram',
    source: 'flowchart LR\n  A --> B',
    title: 'Login flow',
  })
})

it('unwraps a Markdown fence the agent added anyway', async () => {
  const { attach, value } = context()
  await runTool(showDiagram, value, { source: '```mermaid\npie title Pets\n  "Dogs" : 3\n```' })
  expect(attach).toHaveBeenCalledWith({ type: 'diagram', source: 'pie title Pets\n  "Dogs" : 3' })
})

it('refuses text that is not Mermaid, and oversized source', async () => {
  const { attach, value } = context()
  expect(await runTool(showDiagram, value, { source: 'Here is my diagram' })).toMatchObject({
    ok: false,
    text: expect.stringContaining('start with a diagram type'),
  })
  expect(
    await runTool(showDiagram, value, { source: `flowchart LR\n${'A --> B\n'.repeat(3000)}` }),
  ).toMatchObject({ ok: false, text: expect.stringContaining('Invalid input') })
  expect(attach).not.toHaveBeenCalled()
})

it('summarizes the step for the work log, even before the input arrives', () => {
  expect(showDiagram.summarize?.({ source: '', title: undefined } as never)).toBeUndefined()
  expect(showDiagram.summarize?.({ source: 'gantt\n  title x' })).toBe('Gantt chart')
  expect(showDiagram.summarize?.({ source: 'gantt', title: 'Release plan' })).toBe('Release plan')
})
