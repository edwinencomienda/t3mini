import { memo, useEffect, useState } from 'react'
import {
  CircleCheck,
  CirclePause,
  CircleX,
  Cog,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  Rocket,
  Tag,
} from 'lucide-react'
import type { StatusBlock, StatusKind } from '../blocks'

// A live status card from the agent (show_status): a push, pull request, deploy, release, or
// another long step. The agent only describes it; the icon, colors, and layout are ours.

// GitHub's mark (lucide no longer ships brand icons). Drawn by us, never sent by the agent.
function GitHubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
const icons: Record<StatusKind, () => React.ReactNode> = {
  push: () => <GitHubMark />,
  pr: () => <GitPullRequest size={14} aria-hidden />,
  deploy: () => <Rocket size={14} aria-hidden />,
  release: () => <Tag size={14} aria-hidden />,
  task: () => <Cog size={14} aria-hidden />,
}

// Only https links are drawn as links (the tool checks too; this guards cards saved earlier).
function safeHref(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function duration(from: string, to: number) {
  const seconds = Math.max(0, Math.round((to - Date.parse(from)) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// How long it has run (ticking while it runs) or took.
function Elapsed({ block }: { block: StatusBlock }) {
  const running = block.status === 'running'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  const end = block.endedAt ? Date.parse(block.endedAt) : now
  const time = duration(block.startedAt, end)
  if (!time) return null
  return <span className="status-elapsed">{time}</span>
}

const labels: Record<StatusBlock['status'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: "Didn't finish",
}
// The status as one small mark at the end of the row: a spinner, a check, a cross, or a pause.
function StatusMark({ block }: { block: StatusBlock }) {
  const label = block.status === 'done' && block.kind === 'deploy' ? 'Live' : labels[block.status]
  return (
    <span className="status-mark" title={label} aria-label={label}>
      {block.status === 'running' ? (
        <LoaderCircle size={14} className="status-spinner" aria-hidden />
      ) : block.status === 'done' ? (
        <CircleCheck size={14} aria-hidden />
      ) : block.status === 'failed' ? (
        <CircleX size={14} aria-hidden />
      ) : (
        <CirclePause size={14} aria-hidden />
      )}
    </span>
  )
}

// Commits beyond this show as "+N more".
const shownCommits = 3

// One slim row, like a work-log step: icon, title, detail, then the stage, link, time, and status.
// Commits and an error only add a line or two under it when there are any.
export const StatusCard = memo(function StatusCard({ block }: { block: StatusBlock }) {
  const href = safeHref(block.url)
  const label = block.urlLabel || (href ? new URL(href).host : '')
  const stages = block.stages ?? []
  const at = block.stage ? stages.indexOf(block.stage) : -1
  // While it runs (or where it stopped): "Build 1/4". Done needs no stage.
  const stage =
    block.status !== 'done' && at >= 0 ? `${block.stage} ${at + 1}/${stages.length}` : ''
  const commits = block.commits ?? []
  return (
    <section
      className={`status-card ${block.status}`}
      aria-label={`${block.title}: ${labels[block.status]}`}
    >
      <div className="status-row">
        <span className="status-icon">{icons[block.kind]?.() ?? icons.task()}</span>
        <span className="status-title">{block.title}</span>
        {block.detail ? <span className="status-detail">{block.detail}</span> : null}
        <span className="status-end">
          {stage ? <span className="status-stage">{stage}</span> : null}
          {href ? (
            <a className="status-link" href={href} target="_blank" rel="noopener noreferrer">
              {label}
              <ExternalLink size={11} aria-hidden />
            </a>
          ) : null}
          <Elapsed block={block} />
          <StatusMark block={block} />
        </span>
      </div>
      {commits.length ? (
        <ul className="status-commits">
          {commits.slice(0, shownCommits).map((commit) => (
            <li key={commit.sha}>
              <code>{commit.sha}</code>
              <span>{commit.message}</span>
            </li>
          ))}
          {commits.length > shownCommits ? (
            <li className="status-more">+{commits.length - shownCommits} more</li>
          ) : null}
        </ul>
      ) : null}
      {block.error ? <pre className="status-error">{block.error}</pre> : null}
      {block.status === 'running' ? (
        // A hairline along the bottom: how far through the stages, or moving when unknown.
        <div className="status-progress" aria-hidden>
          <i
            className={at >= 0 ? 'known' : ''}
            style={at >= 0 ? { width: `${((at + 0.5) / stages.length) * 100}%` } : undefined}
          />
        </div>
      ) : null}
    </section>
  )
})
