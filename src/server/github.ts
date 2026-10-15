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
