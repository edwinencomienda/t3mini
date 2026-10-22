import { expect, it } from 'vitest'
import { selectorName } from './browser'

it('names Playwright selectors in words for the work log', () => {
  expect(selectorName('role=button[name="Finish game"] >> nth=1')).toBe('“Finish game”')
  expect(selectorName('role=dialog >> role=button[name="Finish game"]')).toBe(
    '“Finish game” in the dialog',
  )
  expect(selectorName('section[aria-labelledby="standings-heading"] li >> nth=0')).toBe(
    'the standings',
  )
  expect(selectorName("role=link[name='Sign up' i]")).toBe('“Sign up”')
  expect(selectorName('text=Sign up')).toBe('“Sign up”')
  expect(selectorName('text="Log in"')).toBe('“Log in”')
  expect(selectorName('button[aria-label="Close"]')).toBe('“Close”')
  expect(selectorName('role=navigation >> role=link[name="Home"] >> visible=true')).toBe(
    '“Home” in the navigation',
  )
})

it('keeps selectors it doesn’t recognize as written', () => {
  expect(selectorName('#save')).toBe('#save')
  expect(selectorName('.card:nth-child(2) button')).toBe('.card:nth-child(2) button')
  expect(selectorName('role=dialog >> .footer button')).toBe('role=dialog >> .footer button')
})
