import { Fragment, memo, useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react'
import { splitRows, type DiffFile, type DiffLine, type DiffResult } from '../diff'
import { Segmented } from './ui'

export type DiffView = 'inline' | 'split'
const viewKey = 't3-mini:diff-view'
export function loadDiffView(): DiffView {
  try {
    return localStorage.getItem(viewKey) === 'split' ? 'split' : 'inline'
  } catch {
    return 'inline'
  }
}
// Panel width in pixels, remembered across reloads. Clamped so the chat keeps room too.
const widthKey = 't3-mini:diff-width'
const minWidth = 320
const minChat = 360
function loadWidth() {
  try {
    const saved = Number(localStorage.getItem(widthKey))
    return Number.isFinite(saved) && saved >= minWidth ? saved : null
  } catch {
    return null
  }
}
// Last diff per project (changes belong to the folder, not the thread), shown instantly on
// switching while a fresh one loads. Every thread in a project shares it, so it is never stale.
const diffs = new Map<string, DiffResult>()
// Files you opened, per project, so switching projects (or reloading) keeps them open.
const openedKey = 't3-mini:diff-opened'
type Opened = Record<string, boolean>
function loadOpened(project: string): Opened {
  try {
    const saved = JSON.parse(localStorage.getItem(openedKey) || '{}') as Record<string, unknown>
    const files = saved[project]
    return Array.isArray(files)
      ? Object.fromEntries(files.filter((key) => typeof key === 'string').map((key) => [key, true]))
      : {}
  } catch {
    return {}
  }
}
function saveOpened(project: string, opened: Opened) {
  try {
    const saved = JSON.parse(localStorage.getItem(openedKey) || '{}') as Record<string, unknown>
    // Only open files are stored; closed is the default.
    const files = Object.keys(opened)
      .filter((key) => opened[key])
      .slice(0, 500)
    if (files.length) saved[project] = files
    else delete saved[project]
    localStorage.setItem(openedKey, JSON.stringify(saved))
  } catch {
    // Without storage the open files are kept until reload.
  }
}
const fileKey = (file: DiffFile) => `${file.oldPath ?? ''}:${file.path}`
const sign = { add: '+', del: '-', ctx: ' ' }

function Code({ line }: { line?: DiffLine }) {
  if (!line) return <td className="diff-code empty" colSpan={1} />
  return (
    <td className={`diff-code ${line.type}`}>
      <span className="diff-sign">{sign[line.type]}</span>
      {line.text}
    </td>
  )
}

function FileDiff({
  file,
  view,
  open,
  onToggle,
}: {
  file: DiffFile
  view: DiffView
  open: boolean
  onToggle: () => void
}) {
  return (
    <section className="diff-file">
      <button className="diff-file-header" onClick={onToggle} aria-expanded={open}>
        <ChevronRight size={13} className={`chevron ${open ? 'open' : ''}`} />
        <span className="diff-path" title={file.path}>
          {file.oldPath ? `${file.oldPath} → ` : ''}
          {file.path}
        </span>
        {file.status !== 'modified' ? (
          <span className={`diff-status ${file.status}`}>{file.status}</span>
        ) : null}
        <span className="diff-count">
          {file.additions ? <span className="add">+{file.additions}</span> : null}
          {file.deletions ? <span className="del">−{file.deletions}</span> : null}
        </span>
      </button>
      {open ? (
        file.tooLarge ? (
          <p className="diff-note">
            Too large to show here ({(file.additions + file.deletions).toLocaleString()} changed
            lines). Open it in your editor.
          </p>
        ) : file.binary ? (
          <p className="diff-note">Binary or large file, not shown.</p>
        ) : !file.hunks.length ? (
          <p className="diff-note">No content changes.</p>
        ) : (
          <div className="diff-scroll">
            <table className={`diff-table ${view}`}>
              <tbody>
                {file.hunks.map((hunk, index) => (
                  <Fragment key={index}>
                    <tr className="diff-hunk">
                      <td colSpan={view === 'split' ? 4 : 3}>{hunk.header}</td>
                    </tr>
                    {view === 'inline'
                      ? hunk.lines.map((line, row) => (
                          <tr key={row}>
                            <td className="diff-ln">{line.old ?? ''}</td>
                            <td className="diff-ln">{line.new ?? ''}</td>
                            <Code line={line} />
                          </tr>
                        ))
                      : splitRows(hunk.lines).map((row, index) => (
                          <tr key={index}>
                            <td className="diff-ln">{row.left?.old ?? ''}</td>
                            <Code line={row.left} />
                            <td className="diff-ln">{row.right?.new ?? ''}</td>
                            <Code line={row.right} />
                          </tr>
                        ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </section>
  )
}

// Uncommitted changes in the thread's project. Refreshes when the agent finishes a step
// (refreshKey changes), when you return to the window, and on demand.
// Memoized: it only re-renders when its own props change, not on every composer keystroke.
export const DiffPanel = memo(function DiffPanel({
  threadId,
  project,
  refreshKey,
  onClose,
}: {
  threadId: string
  project: string
  refreshKey: string
  onClose: () => void
}) {
  const [diff, setDiff] = useState<DiffResult | null>(() => diffs.get(project) ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<DiffView>(loadDiffView)
  const [reload, setReload] = useState(0)
  // null = default width (40% of the space, at most 36rem); set once the user drags the handle.
  const [width, setWidth] = useState<number | null>(null)
  const panel = useRef<HTMLElement>(null)
  // Files start collapsed; this holds the ones the user opened (or closed again).
  const [opened, setOpenedState] = useState<Opened>(() => loadOpened(project))
  function setOpened(update: (current: Opened) => Opened) {
    setOpenedState((current) => {
      const next = update(current)
      saveOpened(project, next)
      return next
    })
  }
  const isOpen = (file: DiffFile) => opened[fileKey(file)] ?? false
  const anyOpen = Boolean(diff?.files.some(isOpen))
  function setAll(open: boolean) {
    setOpened(() =>
      open ? Object.fromEntries((diff?.files ?? []).map((file) => [fileKey(file), true])) : {},
    )
  }
  useEffect(() => setWidth(loadWidth()), [])
  const clamp = (value: number) => {
    const available = panel.current?.parentElement?.clientWidth ?? window.innerWidth
    return Math.round(Math.max(minWidth, Math.min(value, available - minChat)))
  }
  function saveWidth(value: number | null) {
    setWidth(value)
    try {
      if (value === null) localStorage.removeItem(widthKey)
      else localStorage.setItem(widthKey, String(value))
    } catch {
      // The width still applies for this session.
    }
  }
  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const right = panel.current!.getBoundingClientRect().right
    let latest = width
    const move = (moveEvent: PointerEvent) => {
      latest = clamp(right - moveEvent.clientX)
      setWidth(latest)
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      document.body.classList.remove('resizing')
      handle.classList.remove('dragging')
      saveWidth(latest)
    }
    document.body.classList.add('resizing')
    handle.classList.add('dragging')
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  useEffect(() => setDiff(diffs.get(project) ?? null), [project])
  useEffect(() => setOpenedState(loadOpened(project)), [project])
  useEffect(() => {
    const controller = new AbortController()
    // Debounced so a burst of tool steps triggers one git run.
    const timer = setTimeout(() => {
      setLoading(true)
      fetch(`/api/threads/${threadId}/diff`, { signal: controller.signal })
        .then(async (response) => {
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || 'Could not load changes.')
          diffs.set(project, data as DiffResult)
          setDiff(data as DiffResult)
          setError('')
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted) setError(error.message)
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [threadId, refreshKey, reload])
  useEffect(() => {
    const refresh = () => setReload((count) => count + 1)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  useEffect(() => {
    // Catch changes made outside the agent too (your editor, a terminal, git): poll a cheap
    // fingerprint every 2s while the tab is visible and reload the diff only when it changes.
    const controller = new AbortController()
    let last: string | null | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const response = await fetch(`/api/threads/${threadId}/diff/version`, {
            signal: controller.signal,
          })
          const { version } = (await response.json()) as { version: string | null }
          if (last !== undefined && version !== last) setReload((count) => count + 1)
          last = version
        } catch {
          if (controller.signal.aborted) return
        }
      }
      // Scheduled after each check finishes, so slow repos never stack up requests.
      timer = setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [threadId])
  function changeView(next: DiffView) {
    setView(next)
    try {
      localStorage.setItem(viewKey, next)
    } catch {
      // The view still switches for this session.
    }
  }
  const additions = diff?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0
  const deletions = diff?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0
  return (
    <aside
      className="diff-panel"
      aria-label="Changes"
      ref={panel}
      style={width ? ({ '--diff-width': `${width}px` } as React.CSSProperties) : undefined}
    >
      <div
        className="diff-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize changes panel"
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => saveWidth(null)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const current = panel.current?.getBoundingClientRect().width ?? minWidth
          saveWidth(clamp(current + (event.key === 'ArrowLeft' ? 32 : -32)))
        }}
      />
      <header className="diff-header">
        <strong>Changes</strong>
        {diff?.files.length ? (
          <span className="diff-summary">
            {diff.totalFiles > diff.files.length
              ? `${diff.files.length} of ${diff.totalFiles.toLocaleString()} files`
              : `${diff.files.length} ${diff.files.length === 1 ? 'file' : 'files'}`}
            <span className="add">+{additions}</span>
            <span className="del">−{deletions}</span>
          </span>
        ) : null}
        <div className="diff-header-actions">
          <Segmented
            label="Diff view"
            value={view}
            onChange={changeView}
            options={[
              { value: 'inline', label: 'Inline' },
              { value: 'split', label: 'Split' },
            ]}
          />
          <button
            className="icon-button"
            aria-label={anyOpen ? 'Collapse all files' : 'Expand all files'}
            title={anyOpen ? 'Collapse all' : 'Expand all'}
            disabled={!diff?.files.length}
            onClick={() => setAll(!anyOpen)}
          >
            {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
          </button>
          <button
            className="icon-button"
            aria-label="Refresh changes"
            title="Refresh"
            disabled={loading}
            onClick={() => setReload((count) => count + 1)}
          >
            {loading ? (
              <LoaderCircle size={14} className="status-spinner" />
            ) : (
              <RefreshCw size={14} />
            )}
          </button>
          <button
            className="icon-button"
            aria-label="Close changes"
            title="Close"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="diff-body">
        {error ? <p className="diff-empty">{error}</p> : null}
        {!diff && !error ? <p className="diff-empty">Loading changes…</p> : null}
        {diff && !diff.repo ? (
          <p className="diff-empty">This project isn’t a git repository.</p>
        ) : null}
        {diff?.repo && !diff.files.length ? (
          <p className="diff-empty">No uncommitted changes.</p>
        ) : null}
        {diff?.files.map((file) => (
          <FileDiff
            key={fileKey(file)}
            file={file}
            view={view}
            open={isOpen(file)}
            onToggle={() =>
              setOpened((current) => ({ ...current, [fileKey(file)]: !isOpen(file) }))
            }
          />
        ))}
        {diff?.truncated ? (
          <p className="diff-note">
            {diff.totalFiles > diff.files.length
              ? `Showing the first ${diff.files.length} of ${diff.totalFiles.toLocaleString()} changed files. Use your editor or git for the rest.`
              : 'Some changes are too large to show here.'}
          </p>
        ) : null}
      </div>
    </aside>
  )
})
