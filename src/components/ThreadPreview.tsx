import { useEffect, useState } from 'react'
import { threadApi } from '../hub'
import { PreviewCard } from '@base-ui/react/preview-card'
import { LoaderCircle } from 'lucide-react'
import { effortLabel, permissionModes } from '../agent-settings'
import type { Status, ThreadGlance } from '../types'
import { ProviderMark, providerNames } from './AgentSettingsControls'

// The sidebar's hover card: rest the pointer on a thread for a moment to see a quick look at it
// (agent and settings, size, when it started, how the conversation began and its latest reply)
// without opening it. One card serves every row: each row is a trigger carrying its thread id,
// and the card fetches that thread's glance from the server when it opens (shown instantly from
// the last look while it refreshes).

export const threadPreview = PreviewCard.createHandle<string>()
export const ThreadPreviewTrigger = PreviewCard.Trigger

const glances = new Map<string, ThreadGlance>()

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

function Glance({
  id,
  projectName,
  statusLabel,
  ago,
}: {
  id: string
  projectName: (path: string) => string
  statusLabel: (status: Status) => string
  ago: (iso: string) => string
}) {
  const [glance, setGlance] = useState(() => glances.get(id))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/${threadApi(id, 'glance')}`, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<ThreadGlance>) : null))
      .then((data) => {
        if (!data) return setFailed(true)
        glances.set(id, data)
        setGlance(data)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [id])

  if (!glance)
    return (
      <div className="glance-loading">
        {failed ? (
          'Couldn’t load this thread.'
        ) : (
          <LoaderCircle size={14} className="status-spinner" aria-label="Loading" />
        )}
      </div>
    )
  const permission = permissionModes.find((mode) => mode.value === glance.permissionMode)?.label
  const model = [
    glance.model || 'Default model',
    glance.effort ? effortLabel(glance.effort) : '',
    glance.serviceTier === 'fast' ? 'Fast' : '',
  ].filter(Boolean)
  return (
    <>
      <div className="glance-head">
        <ProviderMark provider={glance.provider} size={14} />
        <strong className="glance-title">{glance.title}</strong>
      </div>
      <div className="glance-meta">
        <span className={`glance-status ${glance.status}`}>{statusLabel(glance.status)}</span>
        <span>·</span>
        <span>{projectName(glance.cwd)}</span>
      </div>
      <dl className="glance-facts">
        <dt>Agent</dt>
        <dd>
          {providerNames[glance.provider]} · {model.join(' · ')}
        </dd>
        {permission ? (
          <>
            <dt>Access</dt>
            <dd>{permission}</dd>
          </>
        ) : null}
        <dt>Messages</dt>
        <dd>{glance.messageCount}</dd>
        <dt>Started</dt>
        <dd>{dateTime(glance.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{ago(glance.updatedAt)}</dd>
      </dl>
      {glance.waitingOn ? (
        <p className="glance-waiting">
          <span>Waiting on you:</span> {glance.waitingOn}
        </p>
      ) : null}
      {glance.error && glance.status === 'failed' ? (
        <p className="glance-error">{glance.error}</p>
      ) : null}
      {glance.firstMessage ? (
        <div className="glance-excerpt">
          <span>You asked</span>
          <p>{glance.firstMessage}</p>
        </div>
      ) : null}
      {glance.lastReply ? (
        <div className="glance-excerpt">
          <span>Latest reply</span>
          <p>{glance.lastReply}</p>
        </div>
      ) : null}
    </>
  )
}

export function ThreadPreviewCard(props: {
  projectName: (path: string) => string
  statusLabel: (status: Status) => string
  ago: (iso: string) => string
}) {
  return (
    <PreviewCard.Root handle={threadPreview}>
      {({ payload }) => (
        <PreviewCard.Portal>
          <PreviewCard.Positioner
            className="picker-positioner"
            side="right"
            align="start"
            sideOffset={10}
            collisionPadding={8}
          >
            <PreviewCard.Popup className="thread-glance">
              {payload ? <Glance key={payload} id={payload} {...props} /> : null}
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      )}
    </PreviewCard.Root>
  )
}
