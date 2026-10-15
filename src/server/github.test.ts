import { describe, expect, it } from 'vitest'
import { githubBranchUrl, githubRepoUrl } from './github'

describe('githubRepoUrl', () => {
  it.each([
    ['git@github.com:edwin/t3-mini.git', 'https://github.com/edwin/t3-mini'],
    ['git@github.com:edwin/t3-mini', 'https://github.com/edwin/t3-mini'],
    ['https://github.com/edwin/t3-mini', 'https://github.com/edwin/t3-mini'],
    ['https://github.com/edwin/t3-mini.git/', 'https://github.com/edwin/t3-mini'],
    ['ssh://git@github.com/edwin/t3-mini.git', 'https://github.com/edwin/t3-mini'],
    ['ssh://git@github.com:22/edwin/t3-mini.git', 'https://github.com/edwin/t3-mini'],
    ['git://github.com/edwin/t3-mini.git', 'https://github.com/edwin/t3-mini'],
  ])('links %s', (remote, url) => {
    expect(githubRepoUrl(remote)).toBe(url)
  })
  it('never passes credentials from the remote URL to the link', () => {
    expect(githubRepoUrl('https://user:ghp_secret@github.com/edwin/t3-mini.git')).toBe(
      'https://github.com/edwin/t3-mini',
    )
  })
  it.each([
    '',
    'https://gitlab.com/edwin/t3-mini.git',
    'git@gitlab.com:edwin/t3-mini.git',
    'https://github.com.evil.example/edwin/t3-mini',
    'https://github.com/edwin',
    'https://github.com/edwin/t3-mini/extra',
    'https://github.com/../t3-mini',
    'javascript:alert(1)',
    '/Users/edwin/repos/t3-mini',
  ])('rejects %s', (remote) => {
    expect(githubRepoUrl(remote)).toBeNull()
  })
})

it('encodes branch names but keeps their slashes', () => {
  expect(githubBranchUrl('https://github.com/edwin/t3-mini', 'feature/a b#1')).toBe(
    'https://github.com/edwin/t3-mini/tree/feature/a%20b%231',
  )
})
