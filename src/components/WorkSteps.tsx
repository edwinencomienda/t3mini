import { memo, useEffect, useState } from 'react'
import { Check, ChevronRight, CircleCheck, CircleDashed, LoaderCircle, X } from 'lucide-react'
import type { Activity, Todo } from '../types'

// The agent's tool steps in the conversation, Claude Desktop style: one plain-English line per
// step (Claude's own description of a command when it gave one), "Failed" when it failed, and
// the command and its output one click away. While the agent works, a live line at the bottom
// says what it's doing now and for how long.

export const stepTitle = (step: Activity) =>
  step.title || [step.label, step.summary].filter(Boolean).join(' ')

export const StepRow = memo(function StepRow({ step }: { step: Activity }) {
  const hasDetail = Boolean(step.output || (step.detail && step.detail !== step.summary))
  return (
    <details className={`step ${step.status}`}>
      <summary title={step.title ? step.summary : undefined}>
        <span className="step-icon" aria-hidden>
          {step.status === 'running' ? (
            <LoaderCircle size={12} className="status-spinner" />
          ) : step.status === 'failed' ? (
            <X size={12} />
          ) : (
            <Check size={12} />
          )}
        </span>
        {step.agent ? (
          <span className="step-agent" title={`Subagent: ${step.agent}`}>
            {step.agent}
          </span>
        ) : null}
        <span className="step-title">{stepTitle(step)}</span>
        {step.status === 'failed' ? <span className="step-failed">Failed</span> : null}
        <ChevronRight size={13} className="chevron" aria-hidden />
      </summary>
      {/* The full input (command, edit, arguments), then what it returned. */}
      <div className="step-body">
        {step.title && step.summary ? <pre className="step-detail">{step.detail}</pre> : null}
        {!step.title && step.detail && step.detail !== step.summary ? (
          <pre className="step-detail">{step.detail}</pre>
        ) : null}
        {step.output ? (
          <>
            <span className="step-section">Output</span>
            <pre className="step-output">{step.output}</pre>
          </>
        ) : null}
        {!hasDetail ? <p>{step.status === 'running' ? 'Running…' : 'No output.'}</p> : null}
      </div>
    </details>
  )
})

// The agent's to-do list as a checklist that updates in place: done items checked, the
// current one spinning, the rest waiting.
export const TodoCard = memo(function TodoCard({ todos }: { todos: Todo[] }) {
  const done = todos.filter((todo) => todo.status === 'completed').length
  return (
    <ul className="todo-card" aria-label={`To-do list, ${done} of ${todos.length} done`}>
      {todos.map((todo) => (
        <li key={todo.id} className={`todo ${todo.status}`}>
          <span className="todo-icon" aria-hidden>
            {todo.status === 'completed' ? (
              <CircleCheck size={16} />
            ) : todo.status === 'in_progress' ? (
              <LoaderCircle size={16} className="status-spinner" />
            ) : (
              <CircleDashed size={16} />
            )}
          </span>
          <span className="todo-text">{todo.text}</span>
          <span className="visually-hidden">
            {todo.status === 'completed'
              ? ' (done)'
              : todo.status === 'in_progress'
                ? ' (in progress)'
                : ''}
          </span>
        </li>
      ))}
    </ul>
  )
})

// While the agent works, a run of steps between its notes is one line showing the latest
// step (like Claude Code), so the chat doesn't fill up with every command. Click it to see
// them all.
export function StepGroup({ steps }: { steps: Activity[] }) {
  const latest = steps.at(-1)!
  if (steps.length === 1) return <StepRow step={latest} />
  const failed = steps.filter((step) => step.status === 'failed').length
  return (
    <details className={`step step-group ${latest.status}`}>
      <summary>
        <span className="step-icon" aria-hidden>
          {latest.status === 'running' ? (
            <LoaderCircle size={12} className="status-spinner" />
          ) : latest.status === 'failed' ? (
            <X size={12} />
          ) : (
            <Check size={12} />
          )}
        </span>
        <span className="step-title">{stepTitle(latest)}</span>
        <span className="step-count">
          {steps.length} steps
          {failed ? <span className="step-failed"> · {failed} failed</span> : null}
        </span>
        <ChevronRight size={13} className="chevron" aria-hidden />
      </summary>
      <div className="step-group-list">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </div>
    </details>
  )
}

function elapsed(since: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// "∴ Building the package and running unit tests 42s". Ticks on its own, so the timer doesn't
// re-render the conversation every second.
export function LiveLine({ text, since }: { text: string; since?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="live-line" role="status">
      <span className="live-dots" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="live-text">{text}</span>
      {since ? <span className="live-time">{elapsed(since, now)}</span> : null}
    </div>
  )
}
