import { expect, it } from 'vitest'
import { verticalFlowchart } from './diagrams'

it('lays a sideways flowchart out top to bottom', () => {
  expect(verticalFlowchart('flowchart LR\nA --> B')).toBe('flowchart TB\nA --> B')
  expect(verticalFlowchart('graph RL\nA --> B')).toBe('graph TB\nA --> B')
  expect(verticalFlowchart('---\ntitle: Orders\n---\nflowchart LR\nA --> B')).toBe(
    '---\ntitle: Orders\n---\nflowchart TB\nA --> B',
  )
})

it('leaves everything else alone', () => {
  expect(verticalFlowchart('flowchart TD\nA --> B')).toBeNull()
  expect(verticalFlowchart('sequenceDiagram\nA->>B: hi')).toBeNull()
  // Only the diagram's own direction, not a subgraph's.
  expect(verticalFlowchart('flowchart TB\nsubgraph s\ndirection LR\nA --> B\nend')).toBeNull()
})
