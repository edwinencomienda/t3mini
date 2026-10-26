import { memo, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Collapsible } from '@base-ui/react/collapsible'
import { Popover } from '@base-ui/react/popover'
import {
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleX,
  Eye,
  LoaderCircle,
  ScrollText,
  Square,
  TriangleAlert,
} from 'lucide-react'
import type { DelegationBlock } from '../blocks'
import { useApiBase } from '../hub'
import { ProviderMark, providerNames } from './AgentSettingsControls'

// A sub-agent's card (delegate_task): another agent working on a task for this thread. The
// server keeps it up to date as the sub-agent works (server/delegations.ts), so this only
// draws it: what it's doing, its to-dos and time, a Stop button, and once it's done, the files
// it changed and its answer (folded, Base UI Collapsible). Its full log is its own page.

function duration(from: string, to: number) {
  const seconds = Math.max(0, Math.round((to - Date.parse(from)) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
// How long it has run (ticking while it works) or took.
function Elapsed({ block, live }: { block: DelegationBlock; live: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  const time = duration(block.startedAt, block.endedAt ? Date.parse(block.endedAt) : now)
  return time ? <span className="status-elapsed">{time}</span> : null
}

const labels: Record<DelegationBlock['status'], string> = {
  running: 'Working',
  waiting: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
}
function Mark({ status }: { status: DelegationBlock['status'] }) {
  return (
    <span className="status-mark" title={labels[status]} aria-label={labels[status]}>
      {status === 'running' ? (
        <LoaderCircle size={14} className="status-spinner" aria-hidden />
      ) : status === 'waiting' ? (
        <CircleAlert size={14} aria-hidden />
      ) : status === 'done' ? (
        <CircleCheck size={14} aria-hidden />
      ) : status === 'failed' ? (
        <CircleX size={14} aria-hidden />
      ) : (
        <CirclePause size={14} aria-hidden />
      )}
    </span>
  )
}

export const DelegationCard = memo(function DelegationCard({ block }: { block: DelegationBlock }) {
  const base = useApiBase()
  const [stopping, setStopping] = useState(false)
  const live = block.status === 'running' || block.status === 'waiting'
  useEffect(() => {
    if (!live) setStopping(false)
  }, [live])
  const stop = async () => {
    setStopping(true)
    try {
      const response = await fetch(`${base}/threads/${encodeURIComponent(block.id)}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) setStopping(false)
    } catch {
      setStopping(false)
    }
  }
  const files = block.files ?? []
  const hasDetails = !live && (files.length > 0 || Boolean(block.answer))
  // What it's doing now, else its access when that matters.
  const detail = live ? block.step : block.access === 'read-only' ? 'Read-only' : undefined
  return (
    <section
      data-delegation={block.id}
      className={`status-card delegation-card ${block.status}`}
      aria-label={`Sub-agent ${block.title}: ${labels[block.status]}`}
    >
      <div className="status-row">
        <span className="status-icon" title={`${providerNames[block.agent]} sub-agent`}>
          <ProviderMark provider={block.agent} size={14} />
        </span>
        <span className="status-title">{block.title}</span>
        {detail ? <span className="status-detail">{detail}</span> : null}
        <span className="status-end">
          {block.access === 'read-only' && live ? (
            <span
              className="delegation-tag"
              title="Read-only: asked to look and report without changing files"
            >
              <Eye size={11} aria-hidden />
            </span>
          ) : null}
          {block.background ? <span className="delegation-tag">Background</span> : null}
          {block.todos ? (
            <span className="status-stage" title="Its to-do list">
              {block.todos.done}/{block.todos.total}
            </span>
          ) : null}
          <Elapsed block={block} live={live} />
          <Link
            className="delegation-action"
            to="/threads/$threadId"
            params={{ threadId: block.id }}
            title="Open its full log"
            aria-label={`Open the full log of ${block.title}`}
          >
            <ScrollText size={13} aria-hidden />
          </Link>
          {live ? (
            <button
              type="button"
              className="delegation-action"
              onClick={() => void stop()}
              disabled={stopping}
              title="Stop this sub-agent"
              aria-label={`Stop ${block.title}`}
            >
              <Square size={11} aria-hidden />
            </button>
          ) : null}
          <Mark status={block.status} />
        </span>
      </div>
      {block.status === 'waiting' ? (
        <div className="delegation-note waiting">
          <span>It needs your answer before it can go on.</span>
          <Link to="/threads/$threadId" params={{ threadId: block.id }}>
            Answer
          </Link>
        </div>
      ) : null}
      {block.overlaps?.length ? (
        <div className="delegation-note overlap">
          <TriangleAlert size={12} aria-hidden />
          <span>Also changed by another sub-agent: {block.overlaps.join(', ')}</span>
        </div>
      ) : null}
      {block.error ? <pre className="status-error">{block.error}</pre> : null}
      {hasDetails ? (
        <Collapsible.Root className="delegation-details">
          <Collapsible.Trigger className="delegation-toggle">
            <ChevronRight size={12} aria-hidden />
            {[
              files.length ? `${files.length} file${files.length === 1 ? '' : 's'} changed` : '',
              block.answer ? 'its answer' : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Collapsible.Trigger>
          <Collapsible.Panel className="delegation-panel">
            {files.length ? (
              <ul className="delegation-files">
                {files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {block.answer ? (
              <div className="markdown delegation-answer">
                <Markdown remarkPlugins={[remarkGfm]}>{block.answer}</Markdown>
              </div>
            ) : null}
          </Collapsible.Panel>
        </Collapsible.Root>
      ) : null}
      {live ? (
        <div className="status-progress" aria-hidden>
          <i
            className={block.todos ? 'known' : ''}
            style={
              block.todos
                ? { width: `${((block.todos.done + 0.5) / block.todos.total) * 100}%` }
                : undefined
            }
          />
        </div>
      ) : null}
    </section>
  )
})

// Under the composer while sub-agents work: "2 sub-agents". Its popover (Base UI Popover, like
// the processes chip) lists them; a row scrolls to its card.
export const SubAgentChip = memo(function SubAgentChip({ live }: { live: DelegationBlock[] }) {
  const [open, setOpen] = useState(false)
  if (!live.length) return null
  const waiting = live.some((block) => block.status === 'waiting')
  const show = (id: string) => {
    setOpen(false)
    document
      .querySelector(`[data-delegation="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  return (
    <div className="process-indicator">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={`process-chip running ${waiting ? 'waiting' : ''}`}
          title="Sub-agents working for this thread"
        >
          <Bot size={12} aria-hidden />
          {live.length} sub-agent{live.length === 1 ? '' : 's'}
          {waiting ? ' · needs you' : ''}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="picker-positioner"
            side="top"
            align="end"
            sideOffset={6}
            collisionPadding={8}
          >
            <Popover.Popup className="process-menu" aria-label="Sub-agents">
              <Popover.Title className="picker-heading">Sub-agents at work</Popover.Title>
              {live.map((block) => (
                <button
                  type="button"
                  className="process-row subagent-row"
                  key={block.id}
                  onClick={() => show(block.id)}
                >
                  <ProviderMark provider={block.agent} size={12} />
                  <span className="process-main">
                    <span className="process-name">{block.title}</span>
                    <span className="process-meta">
                      {block.status === 'waiting' ? 'Waiting for you' : (block.step ?? 'Working')}
                    </span>
                  </span>
                </button>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
})
