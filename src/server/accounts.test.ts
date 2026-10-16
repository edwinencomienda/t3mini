import { expect, it } from 'vitest'
import { codexPlanLabel } from './accounts'

it('names Codex plans the way people know them', () => {
  expect(codexPlanLabel('prolite')).toBe('ChatGPT Pro 5x')
  expect(codexPlanLabel('pro')).toBe('ChatGPT Pro 20x')
  expect(codexPlanLabel('plus')).toBe('ChatGPT Plus')
  expect(codexPlanLabel('self_serve_business_usage_based')).toBe('ChatGPT Business')
  expect(codexPlanLabel('edu_pro')).toBe('ChatGPT Edu')
  expect(codexPlanLabel('something-new')).toBeUndefined()
  expect(codexPlanLabel(null)).toBeUndefined()
})
