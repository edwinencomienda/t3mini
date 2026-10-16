// GitHub web links for a project, worked out from its git remote URL (no gh CLI).
// Links are rebuilt from the owner and repository name only, so credentials that some remote
// URLs carry (https://user:token@github.com/…) never reach the browser.

const part = /^[A-Za-z0-9_.-]+$/

// The repository page for a GitHub remote URL, or null for any other host or shape.
// Accepts git@github.com:owner/repo.git, ssh://git@github.com/owner/repo.git,
// https://github.com/owner/repo(.git), and git://github.com/owner/repo.git.
export function githubRepoUrl(remote: string): string | null {
  const value = remote.trim()
  let path: string | undefined
  const scp = /^[\w.-]+@github\.com:(.+)$/i.exec(value)
  if (scp) path = scp[1]
  else {
    try {
      const url = new URL(value)
      if (
        ['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) &&
        url.hostname.toLowerCase() === 'github.com'
      )
        path = url.pathname
    } catch {
      return null
    }
  }
  const [owner, repo, ...rest] = (path ?? '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/')
  if (!owner || !repo || rest.length || !part.test(owner) || !part.test(repo)) return null
  if (['.', '..'].includes(owner) || ['.', '..'].includes(repo)) return null
  return `https://github.com/${owner}/${repo}`
}

// A branch's page in a GitHub repository; each path segment is encoded.
export const githubBranchUrl = (repoUrl: string, branch: string) =>
  `${repoUrl}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`

// The open pull request for a commit, from `git ls-remote <remote> 'refs/pull/*'` output. GitHub
// keeps two refs per pull request:
// - refs/pull/<n>/head: the PR's latest commit, kept forever, so a branch whose pushed commit
//   matches is that PR's branch;
// - refs/pull/<n>/merge: a test merge GitHub keeps only while the PR is open, so merged and
//   closed PRs don't count. (An open PR with conflicts may have no merge ref, so it's missed.)
// The newest open PR wins when several point at the same commit.
export function pullRequestFor(lsRemote: string, sha: string) {
  const heads: number[] = []
  const open = new Set<number>()
  for (const line of lsRemote.split('\n')) {
    const [hash, ref] = line.trim().split(/\s+/)
    const [, number, kind] = ref?.match(/^refs\/pull\/(\d+)\/(head|merge)$/) ?? []
    if (!number) continue
    if (kind === 'merge') open.add(Number(number))
    else if (sha && hash === sha) heads.push(Number(number))
  }
  const matches = heads.filter((number) => open.has(number))
  return matches.length ? Math.max(...matches) : undefined
}
export const githubPullUrl = (repoUrl: string, number: number) => `${repoUrl}/pull/${number}`
