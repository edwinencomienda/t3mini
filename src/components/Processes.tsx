import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RotateCw, ScrollText, Smartphone, Square, Terminal, X } from 'lucide-react'
import type { ProcessInfo } from '../server/processes'
import { Popover } from '@base-ui/react/popover'
import { Modal, ModalTitle } from './Modal'
import { openPreview } from '../open-preview'

// The "● 2 running" indicator under the composer for the open project's processes, a list of
// them with Logs / Restart / Stop, and a live log viewer.

async function call(path: string, method = 'POST') {
  const response = await fetch(`/api/processes/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: '{}' }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data
}
const since = (iso: string, now: number) => {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
const statusLabel = (info: ProcessInfo) =>
  info.status === 'failed' && info.exitCode !== undefined && info.exitCode !== null
    ? `Failed (exit ${info.exitCode})`
    : {
        running: 'Running',
        stopping: 'Stopping…',
        exited: 'Finished',
        failed: 'Failed',
        stopped: 'Stopped',
      }[info.status]

function LogViewer({ process, onClose }: { process: ProcessInfo; onClose: () => void }) {
  const [logs, setLogs] = useState('')
  const [error, setError] = useState('')
  const output = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  // Poll while open (only one process's output, every second).
  useEffect(() => {
    let cancelled = false
    const load = () =>
      call(`${process.id}/logs?lines=1000`, 'GET')
        .then((data: { logs: string }) => {
          if (!cancelled) setLogs(data.logs)
        })
        .catch((error: Error) => {
          if (!cancelled) setError(error.message)
        })
    void load()
    const timer = setInterval(load, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [process.id])
  useEffect(() => {
    const element = output.current
    if (element && follow.current) element.scrollTop = element.scrollHeight
  }, [logs])
  return (
    <Modal className="new-dialog process-logs" onClose={onClose}>
      <div className="dialog-top">
        <ModalTitle render={<h2 />}>
          {process.name} <small>{statusLabel(process)}</small>
        </ModalTitle>
        <button type="button" className="icon-button" aria-label="Close logs" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <code className="process-command">{process.command}</code>
      <pre
        ref={output}
        className="process-output"
        onScroll={() => {
          const element = output.current
          if (element)
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
        }}
      >
        {logs || (error ? error : 'No output yet.')}
      </pre>
    </Modal>
  )
}

export function ProcessIndicator({
  processes,
  project,
  remote = false,
}: {
  processes: ProcessInfo[]
  project: string
  // On a paired device: dev servers open through a preview address instead of localhost.
  remote?: boolean
}) {
  const mine = processes.filter((info) => info.project === project)
  const running = mine.filter((info) => info.status === 'running' || info.status === 'stopping')
  const [open, setOpen] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])
  if (!mine.length) return null
  const act = (path: string, method?: string) =>
    call(path, method).then(
      () => setError(''),
      (error: Error) => setError(error.message),
    )
  const viewed = mine.find((info) => info.id === viewing)
  return (
    <div className="process-indicator">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={`process-chip ${running.length ? 'running' : ''}`}
          title="Processes in this project"
        >
          <span className="process-dot" />
          {running.length ? `${running.length} running` : `${mine.length} finished`}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="picker-positioner"
            side="top"
            align="end"
            sideOffset={6}
            collisionPadding={8}
          >
            <Popover.Popup className="process-menu" aria-label="Processes">
              <Popover.Title className="picker-heading">Processes in this project</Popover.Title>
              {mine.map((info) => {
                const live = info.status === 'running' || info.status === 'stopping'
                return (
                  <div className={`process-row ${info.status}`} key={info.id}>
                    <div className="process-main">
                      <span className="process-name">
                        <Terminal size={12} />
                        {info.name}
                      </span>
                      {/* Status, then the command, on one line. */}
                      <span className="process-meta">
                        <span className={`process-status ${info.status}`}>
                          {statusLabel(info)}
                          {live ? ` · ${since(info.startedAt, now)}` : ''}
                        </span>
                        <code title={info.command}>{info.command}</code>
                      </span>
                      {live && (info.urls ?? info.url) ? (
                        <span className="process-links">
                          {
                            // Every address it printed (a website and an API side by side): on
                            // a paired device each opens through its preview address.
                            (info.urls ?? (info.url ? [info.url] : [])).map((url) =>
                              remote ? (
                                <button
                                  key={url}
                                  type="button"
                                  className="process-preview"
                                  onClick={() =>
                                    void openPreview(url).then(
                                      () => setError(''),
                                      (error: Error) => setError(error.message),
                                    )
                                  }
                                >
                                  <Smartphone size={11} />
                                  Open :{new URL(url).port} on this device
                                </button>
                              ) : (
                                <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                                  <ExternalLink size={11} />
                                  {url.replace(/^https?:\/\//, '')}
                                </a>
                              ),
                            )
                          }
                        </span>
                      ) : null}
                    </div>
                    <div className="process-actions">
                      <button
                        type="button"
                        className="icon-button"
                        title="Logs"
                        aria-label={`Logs for ${info.name}`}
                        onClick={() => setViewing(info.id)}
                      >
                        <ScrollText size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        title="Restart"
                        aria-label={`Restart ${info.name}`}
                        disabled={info.status === 'stopping'}
                        onClick={() => void act(`${info.id}/restart`)}
                      >
                        <RotateCw size={14} />
                      </button>
                      {live ? (
                        <button
                          type="button"
                          className="icon-button"
                          title="Stop"
                          aria-label={`Stop ${info.name}`}
                          disabled={info.status === 'stopping'}
                          onClick={() => void act(`${info.id}/stop`)}
                        >
                          <Square size={12} fill="currentColor" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="icon-button"
                          title="Remove from list"
                          aria-label={`Remove ${info.name}`}
                          onClick={() => void act(info.id, 'DELETE')}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {error ? <p className="phone-error">{error}</p> : null}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {viewed ? <LogViewer process={viewed} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}
