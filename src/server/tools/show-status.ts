import { z } from 'zod'
import { statusKinds, statusStates } from '../../blocks'
import { defineTool, ToolError } from './types'

// A live status card in the chat for a push, pull request, deploy, release, or any other long
// step (show_status). The agent describes what's happening; t3 mini draws it with its own icons
// and colors (components/StatusCard.tsx), so the agent never sends markup, images, or styles.
// Calls with the same id in a turn update one card in place; one still running when the turn
// ends is marked as not finished (service.ts).

// Links must be plain https addresses: no other schemes (javascript:, file:, http:), and no
// user name or password in them. The card checks again when it draws the link.
export function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

const text = (max: number) => z.string().trim().min(1).max(max)

export const showStatus = defineTool({
  name: 'show_status',
  label: 'Show status',
  description:
    'Show a live status card in the chat for something the user wants to follow: a git push, ' +
    'a pull request, a deploy, a release, or another long step (migration, backup…). Start it ' +
    'with status "running" before you begin, then call again with the same id to move it ' +
    'along (stage) and to finish it: "done" with the link (the PR, the commits, the live site) ' +
    'or "failed" with the key error lines. Send the current title and status each time; other ' +
    'fields you leave out keep their last value. Only describe what actually happened (use ' +
    'the real commit hashes, PR number, and URL from the command output). Skip it for routine ' +
    'steps like reading files or running tests.',
  input: {
    id: z
      .string()
      .regex(/^[\w.-]{1,40}$/, 'Letters, numbers, dots, dashes, and underscores only.')
      .describe('Names this card within the turn, e.g. "push" or "deploy". Reuse it to update.'),
    kind: z
      .enum(statusKinds)
      .describe(
        'push: git push · pr: a pull request · deploy: putting an app live · release: a ' +
          'version or package release · task: anything else. Picks the icon.',
      ),
    status: z.enum(statusStates).describe('running while it happens, then done or failed.'),
    title: text(120).describe('e.g. "Pushing to GitHub", "Deployed to Vercel".'),
    detail: text(200)
      .optional()
      .describe('One line under the title, e.g. "myorg/myapp · main" or "Production · 1m 12s".'),
    stages: z
      .array(text(30))
      .min(2)
      .max(8)
      .optional()
      .describe('The steps it goes through, e.g. ["Upload", "Build", "Deploy", "Live"].'),
    stage: text(30).optional().describe('The stage it is on now (one of stages).'),
    commits: z
      .array(
        z.object({
          sha: z
            .string()
            .regex(/^[0-9a-f]{4,40}$/i, 'A commit hash.')
            .describe('The commit hash (shortened to 7 characters).'),
          message: text(200).describe("The commit's subject line."),
        }),
      )
      .max(10)
      .optional()
      .describe('Commits being pushed or included, newest first.'),
    url: z
      .string()
      .max(500)
      .optional()
      .describe('An https link: the pull request, the commits on GitHub, or the live site.'),
    urlLabel: text(60)
      .optional()
      .describe('Link text, e.g. "View on GitHub". Default: the address.'),
    error: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe('When it failed: the few lines that explain why.'),
  },
  safety: 'safe',
  summarize: (input) => (input.title ? `${input.title} · ${input.status ?? ''}` : undefined),
  async run(context, input) {
    let url: string | undefined
    if (input.url !== undefined) {
      url = safeLink(input.url)
      if (!url) throw new ToolError('url must be a plain https address, e.g. https://example.com.')
    }
    if (input.stage && input.stages && !input.stages.includes(input.stage))
      throw new ToolError(`stage must be one of stages: ${input.stages.join(', ')}.`)
    const result = context.showStatus({
      id: input.id,
      kind: input.kind,
      status: input.status,
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.stages ? { stages: input.stages } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.commits
        ? {
            commits: input.commits.map((commit) => ({
              sha: commit.sha.slice(0, 7).toLowerCase(),
              message: commit.message,
            })),
          }
        : {}),
      ...(url ? { url } : {}),
      ...(input.urlLabel ? { urlLabel: input.urlLabel } : {}),
      ...(input.error ? { error: input.error } : {}),
    })
    return result === 'created'
      ? `Status card "${input.id}" shown (${input.status}). Call show_status with id "${input.id}" to update it.`
      : `Status card "${input.id}" updated (${input.status}).`
  },
})
