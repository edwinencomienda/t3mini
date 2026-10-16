import { describe, expect, it } from 'vitest'
import { githubBranchUrl, githubPullUrl, githubRepoUrl, pullRequestFor } from './github'

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

describe('pullRequestFor', () => {
  const refs = [
    'aaa111\trefs/pull/7/head',
    'm7\trefs/pull/7/merge',
    'bbb222\trefs/pull/8/head',
    'm8\trefs/pull/8/merge',
    'aaa111\trefs/pull/12/head',
    'm12\trefs/pull/12/merge',
    // Merged or closed: only the head ref is left.
    'ccc333\trefs/pull/80/head',
    'aaa111\trefs/pull/99/head',
  ].join('\n')
  it('finds the newest open pull request whose head is the commit', () => {
    expect(pullRequestFor(refs, 'aaa111')).toBe(12)
    expect(pullRequestFor(refs, 'bbb222')).toBe(8)
  })
  it('skips merged and closed pull requests (no merge ref)', () => {
    expect(pullRequestFor(refs, 'ccc333')).toBeUndefined()
  })
  it('finds nothing for other commits or an empty commit', () => {
    expect(pullRequestFor(refs, 'ddd444')).toBeUndefined()
    expect(pullRequestFor(refs, '')).toBeUndefined()
    expect(pullRequestFor('', 'aaa111')).toBeUndefined()
  })
  it('links to the pull request page', () => {
    expect(githubPullUrl('https://github.com/edwin/t3-mini', 12)).toBe(
      'https://github.com/edwin/t3-mini/pull/12',
    )
  })
})
