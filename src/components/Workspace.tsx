import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowUp,
  Check,
  ChevronRight,
  Circle,
  Folder,
  FolderOpen,
  LoaderCircle,
  Menu,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Square,
  SquarePen,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import Markdown from 'react-markdown'
import { Link, useNavigate } from '@tanstack/react-router'
import { AgentSettingsControls } from './AgentSettingsControls'
import { defaultPermission, type AgentSettings } from '../agent-settings'
import { loadPreferences, rememberChoice, settingsFor } from '../preferences'
import {
  desktopPermission,
  eventText,
  loadNotificationPreferences,
  requestDesktopPermission,
  saveNotificationPreferences,
  threadEvents,
  type NotificationPreferences,
  type ThreadEvent,
} from '../notifications'
import { NotificationPrompt, SettingsDialog, Toasts } from './Notifications'
import { ThreadMenu, type ThreadMenuState } from './ThreadMenu'
import remarkGfm from 'remark-gfm'
import {
  isActive,
  type Bootstrap,
  type Provider,
  type Status,
  type Thread,
  type ThreadSummary,
} from '../types'

const names: Record<Provider, string> = { codex: 'Codex', claude: 'Claude' }
const labels: Record<Status, string> = {
  idle: 'Ready',
  starting: 'Starting',
  working: 'Working',
  waiting: 'Needs approval',
  completed: 'Completed',
  interrupted: 'Stopped',
  failed: 'Failed',
}
const starters = [
  {
    title: 'Explain this project',
    text: 'Explore this project and explain its architecture, main entry points, and how to run it. Do not change any files.',
  },
  {
    title: 'Find a small improvement',
    text: 'Review this project and suggest one useful, small improvement. Explain your reasoning before making any changes.',
  },
  {
    title: 'Plan a new feature',
    text: 'Help me plan a new feature for this project. First, explore the code and ask me what I want to build.',
  },
]
const folderName = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) || '/'
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

function relativeTime(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
function duration(start: string, end: string) {
  const seconds = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    signal,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data as T
}
function ProviderMark({ provider, size = 14 }: { provider: Provider; size?: number }) {
  return (
    <span
      className={`provider-mark ${provider}`}
      style={{ width: size + 6, height: size + 6, fontSize: size - 1 }}
      aria-hidden
    >
      {provider === 'claude' ? '✳' : <Terminal size={size - 3} />}
    </span>
  )
}
function StatusDot({ status }: { status: Status }) {
  if (status === 'starting' || status === 'working')
    return <LoaderCircle size={12} className="status-spinner" aria-label={labels[status]} />
  return <span className={`status-dot ${status}`} title={labels[status]} />
}
function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`status-badge ${status}`}>
      <StatusDot status={status} />
      {labels[status]}
    </span>
  )
}

export function Workspace({ threadId }: { threadId?: string }) {
  const navigate = useNavigate()
  const activeId = threadId ?? null
  const selectedId = useRef(activeId)
  selectedId.current = activeId
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [thread, setThread] = useState<Thread | null>(null)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [workLogOpen, setWorkLogOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const end = useRef<HTMLDivElement>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const composer = useRef<HTMLTextAreaElement>(null)
  const drafts = useRef(new Map<string, string>())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [menu, setMenu] = useState<ThreadMenuState | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [toasts, setToasts] = useState<ThreadEvent[]>([])
  const [showPrompt, setShowPrompt] = useState(false)
  // Read from localStorage after mount so the server render and first client render match.
  const [notify, setNotify] = useState<NotificationPreferences>({
    desktop: false,
    inApp: true,
    prompted: true,
  })
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  const statuses = useRef(new Map<string, Status>())
  const openThread = useRef<(id: string) => void>(() => {})

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    api<Bootstrap>('bootstrap', 'GET', undefined, controller.signal)
      .then((data) => {
        setBootstrap(data)
        setThreads(data.threads)
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message)
      })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    setThread(null)
    setConnected(false)
    setError('')
    const controller = new AbortController()
    // Validate direct links before subscribing, so a deleted thread has a clear error.
    if (activeId)
      api<Thread>(`threads/${activeId}`, 'GET', undefined, controller.signal).catch(
        (error: Error) => {
          if (!controller.signal.aborted) setError(error.message)
        },
      )
    const events = new EventSource(
      `/api/events${activeId ? `?thread=${encodeURIComponent(activeId)}` : ''}`,
    )
    events.onopen = () => setConnected(true)
    events.onerror = () => setConnected(false)
    events.onmessage = (event) => {
      const data = JSON.parse(event.data) as {
        threads: ThreadSummary[]
        thread: Thread | null
        persistenceError?: string
      }
      announce(threadEvents(statuses.current, data.threads))
      statuses.current = new Map(data.threads.map((item) => [item.id, item.status]))
      setThreads(data.threads)
      setThread(data.thread)
      if (data.persistenceError) setError(data.persistenceError)
    }
    return () => {
      controller.abort()
      events.close()
    }
  }, [activeId])
  useEffect(() => {
    if (stickToBottom.current) end.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
  }, [thread?.messages, thread?.activities, thread?.approvals, activeId])
  useEffect(() => {
    const saved = loadNotificationPreferences()
    const permission = desktopPermission()
    setNotify(saved)
    setShowPrompt(!saved.prompted && (permission === 'default' || permission === 'granted'))
  }, [])
  useEffect(() => {
    // Opening a thread clears its toasts.
    if (activeId) setToasts((current) => current.filter((item) => item.thread.id !== activeId))
  }, [activeId])
  function announce(events: ThreadEvent[]) {
    if (!events.length) return
    const focused = document.visibilityState === 'visible' && document.hasFocus()
    const preferences = notifyRef.current
    for (const event of events) {
      const viewing = focused && event.thread.id === selectedId.current
      if (preferences.inApp && !viewing)
        setToasts((current) => [
          ...current.filter((item) => item.thread.id !== event.thread.id),
          event,
        ])
      if (preferences.desktop && !focused && desktopPermission() === 'granted') {
        try {
          const notification = new Notification(
            `${names[event.thread.provider]} · ${eventText[event.kind]}`,
            { body: event.thread.title, tag: event.thread.id },
          )
          notification.onclick = () => {
            window.focus()
            openThread.current(event.thread.id)
            notification.close()
          }
        } catch {
          // Some browsers only allow notifications from a service worker; the toast still shows.
        }
      }
    }
  }
  function updateNotify(preferences: NotificationPreferences) {
    setNotify(preferences)
    saveNotificationPreferences(preferences)
  }
  async function enableDesktop() {
    const permission = await requestDesktopPermission()
    updateNotify({ ...notifyRef.current, desktop: permission === 'granted', prompted: true })
    setShowPrompt(false)
  }
  useEffect(() => {
    // ⌘⇧O / Ctrl+Shift+O starts a new thread, matching t3code.
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        if (bootstrap) setCreateOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bootstrap])
  useEffect(() => {
    // Typing or pasting while nothing editable is focused goes to the composer, so you can
    // just start typing (or dictating) anywhere in the chat.
    const canRedirect = (target: EventTarget | null) => {
      const element = composer.current
      if (!element || element.disabled || createOpen) return false
      if (!(target instanceof HTMLElement)) return true
      return !target.closest('input, textarea, select, [contenteditable], dialog, [role="menu"]')
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return
      // Space activates a focused button or link; leave it alone there.
      if (event.key === ' ' && event.target !== document.body) return
      if (!canRedirect(event.target)) return
      // Focusing during keydown lets the browser deliver this keystroke to the composer.
      composer.current!.focus()
    }
    const onPaste = (event: ClipboardEvent) => {
      if (!canRedirect(event.target)) return
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      const element = composer.current!
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
      // insertText keeps native undo and fires the input event React listens for.
      if (!document.execCommand('insertText', false, text)) {
        const next = element.value + text
        setDraft(next)
        if (activeId) drafts.current.set(activeId, next)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
    }
  }, [createOpen, activeId])
  useLayoutEffect(() => {
    const element = composer.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`
  }, [draft, activeId])

  function prepareSelection(id: string) {
    if (id === activeId) {
      setSidebarOpen(false)
      return
    }
    if (activeId) drafts.current.set(activeId, draft)
    setThread(null)
    setDraft(drafts.current.get(id) || '')
    setSidebarOpen(false)
    setError('')
    setWorkLogOpen(false)
    stickToBottom.current = true
  }
  function select(id: string) {
    prepareSelection(id)
    void navigate({ to: '/threads/$threadId', params: { threadId: id } })
  }
  openThread.current = select
  useEffect(() => {
    setDraft(activeId ? drafts.current.get(activeId) || '' : '')
    stickToBottom.current = true
  }, [activeId])
  async function updateSettings(settings: AgentSettings) {
    if (!activeId || !thread || busy) return
    setBusy(true)
    setError('')
    try {
      const updated = await api<Thread>(`threads/${activeId}/settings`, 'POST', settings)
      rememberChoice(updated.provider, settings)
      if (selectedId.current === activeId) setThread(updated)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function quickCreate(cwd: string) {
    // One-click thread in an existing project, using the last provider and settings.
    if (busy) return
    const preferences = loadPreferences()
    const provider = preferences.provider ?? 'claude'
    setBusy(true)
    setError('')
    try {
      const created = await api<Thread>('threads', 'POST', {
        provider,
        cwd,
        ...settingsFor(provider, preferences),
      })
      setThreads((current) => [created, ...current])
      select(created.id)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault()
    if (!activeId || !draft.trim() || busy || !connected || !thread || isActive(thread.status))
      return
    const text = draft
    setBusy(true)
    setError('')
    stickToBottom.current = true
    try {
      await api(`threads/${activeId}/send`, 'POST', { text })
      if (selectedId.current === activeId) setDraft('')
      drafts.current.delete(activeId)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
      composer.current?.focus()
    }
  }
  async function action(path: string, body: unknown = {}) {
    setBusy(true)
    setError('')
    try {
      await api(`threads/${activeId}/${path}`, 'POST', body)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function remove(target: Pick<ThreadSummary, 'id' | 'title'> | null = thread) {
    if (
      !target ||
      !window.confirm(`Delete “${target.title}”? This removes the conversation from t3 mini.`)
    )
      return
    setBusy(true)
    try {
      await api(`threads/${target.id}`, 'DELETE', {})
      drafts.current.delete(target.id)
      setToasts((current) => current.filter((item) => item.thread.id !== target.id))
      if (target.id === activeId) {
        void navigate({ to: '/' })
        setThread(null)
        setDraft('')
      }
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const committedRename = useRef<typeof renaming>(null)
  async function rename() {
    // Enter commits and unmounts the input, which can also fire blur; save only once.
    if (!renaming || committedRename.current === renaming) return
    committedRename.current = renaming
    const { id, title } = renaming
    setRenaming(null)
    const current = threads.find((item) => item.id === id)
    if (!title.trim() || title.trim() === current?.title) return
    // Show the new name right away; the live update confirms it.
    setThreads((list) =>
      list.map((item) => (item.id === id ? { ...item, title: title.trim() } : item)),
    )
    try {
      await api(`threads/${id}/rename`, 'POST', { title })
    } catch (error) {
      if (current)
        setThreads((list) =>
          list.map((item) => (item.id === id ? { ...item, title: current.title } : item)),
        )
      setError((error as Error).message)
    }
  }
  const query = search.trim().toLowerCase()
  const visibleThreads = threads.filter((item) =>
    `${item.title} ${item.cwd}`.toLowerCase().includes(query),
  )
  // Group by project folder, most recently active project first (threads arrive newest first).
  const projects = new Map<string, ThreadSummary[]>()
  for (const item of visibleThreads)
    projects.set(item.cwd, [...(projects.get(item.cwd) || []), item])
  const active = thread ? isActive(thread.status) : false
  const folder = thread ? folderName(thread.cwd) : undefined
  const runningCount = threads.filter((item) => isActive(item.status)).length
  const lastUser = thread ? thread.messages.map((message) => message.role).lastIndexOf('user') : -1
  const workLog = thread?.activities.length ? (
    <section className={`work-log ${workLogOpen ? 'open' : ''}`}>
      <button
        className="work-log-toggle"
        onClick={() => setWorkLogOpen(!workLogOpen)}
        aria-expanded={workLogOpen}
      >
        <ChevronRight size={13} className="chevron" />
        <span>
          {active ? 'Working' : 'Work log'} · {thread.activities.length}{' '}
          {thread.activities.length === 1 ? 'step' : 'steps'}
        </span>
        {active ? <LoaderCircle size={12} className="status-spinner" /> : null}
      </button>
      {workLogOpen || active ? (
        <ol className="work-log-list">
          {(workLogOpen ? thread.activities : thread.activities.slice(-3)).map((item) => (
            <li key={item.id} className={item.status}>
              <details>
                <summary>
                  {item.status === 'completed' ? (
                    <Check size={12} />
                  ) : item.status === 'failed' ? (
                    <X size={12} />
                  ) : (
                    <Circle size={9} />
                  )}
                  <span>{item.label}</span>
                </summary>
                {item.detail ? <pre>{item.detail}</pre> : <p>No additional details.</p>}
              </details>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  ) : null

  return (
    <div className="workspace">
      {sidebarOpen ? (
        <button
          className="sidebar-scrim"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="sidebar-header">
          <Link className="brand" to="/" aria-label="t3 mini home">
            <span className="brand-mark">t3</span>
            <span>mini</span>
          </Link>
          <button
            className="icon-button"
            onClick={() => setCreateOpen(true)}
            disabled={!bootstrap}
            aria-label="New thread"
            title={`New thread (${isMac ? '⌘⇧O' : 'Ctrl+Shift+O'})`}
          >
            <SquarePen size={16} />
          </button>
        </div>
        <label className="search">
          <Search size={14} />
          <input
            aria-label="Search threads"
            placeholder="Search threads"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <nav className="thread-list" aria-label="Threads">
          {[...projects].map(([cwd, items]) => (
            <section className="project" key={cwd}>
              <div className="project-header">
                <button
                  className="project-toggle"
                  onClick={() => setCollapsed({ ...collapsed, [cwd]: !collapsed[cwd] })}
                  aria-expanded={!collapsed[cwd]}
                  title={cwd}
                >
                  {collapsed[cwd] ? <Folder size={14} /> : <FolderOpen size={14} />}
                  <span>{folderName(cwd)}</span>
                </button>
                <button
                  className="icon-button project-add"
                  aria-label={`New thread in ${folderName(cwd)}`}
                  title={`New thread in ${folderName(cwd)}`}
                  disabled={busy}
                  onClick={() => void quickCreate(cwd)}
                >
                  <Plus size={14} />
                </button>
              </div>
              {!collapsed[cwd]
                ? items.map((item) =>
                    renaming?.id === item.id ? (
                      <div className="thread-row selected renaming" key={item.id}>
                        <StatusDot status={item.status} />
                        <input
                          className="thread-rename"
                          aria-label="Thread name"
                          autoFocus
                          maxLength={120}
                          value={renaming.title}
                          onFocus={(event) => event.target.select()}
                          onChange={(event) =>
                            setRenaming({ id: item.id, title: event.target.value })
                          }
                          onBlur={() => void rename()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void rename()
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              setRenaming(null)
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <Link
                        key={item.id}
                        to="/threads/$threadId"
                        params={{ threadId: item.id }}
                        className={`thread-row ${activeId === item.id ? 'selected' : ''}`}
                        onClick={(event) => {
                          if (busy) {
                            event.preventDefault()
                            return
                          }
                          if (
                            !event.metaKey &&
                            !event.ctrlKey &&
                            !event.shiftKey &&
                            !event.altKey &&
                            event.button === 0
                          )
                            prepareSelection(item.id)
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          const rect = event.currentTarget.getBoundingClientRect()
                          // Keyboard-opened menus (Shift+F10) report 0,0; anchor them to the row.
                          const fromKeyboard = event.clientX === 0 && event.clientY === 0
                          setMenu({
                            id: item.id,
                            x: fromKeyboard ? rect.left + 24 : event.clientX,
                            y: fromKeyboard ? rect.bottom : event.clientY,
                          })
                        }}
                        onDoubleClick={(event) => {
                          event.preventDefault()
                          setRenaming({ id: item.id, title: item.title })
                        }}
                        aria-disabled={busy}
                        aria-current={activeId === item.id ? 'page' : undefined}
                      >
                        <StatusDot status={item.status} />
                        <span className="thread-title">{item.title}</span>
                        <span className="thread-time">
                          {item.status === 'waiting'
                            ? 'Approval'
                            : relativeTime(item.updatedAt, now)}
                        </span>
                      </Link>
                    ),
                  )
                : null}
            </section>
          ))}
          {!visibleThreads.length ? (
            <div className="empty-sidebar">
              {search ? 'No matching threads.' : bootstrap ? 'No threads yet.' : 'Loading…'}
            </div>
          ) : null}
        </nav>
        <div className="sidebar-footer">
          {(['claude', 'codex'] as const).map((provider) => (
            <div
              className="agent-health"
              key={provider}
              title={
                bootstrap?.providers[provider].installed
                  ? `${names[provider]} CLI ${bootstrap.providers[provider].version || 'installed'}`
                  : `${names[provider]} CLI not found`
              }
            >
              <ProviderMark provider={provider} size={12} />
              <span>{names[provider]}</span>
              <span
                className={`health-dot ${bootstrap?.providers[provider].installed ? 'available' : ''}`}
              />
            </div>
          ))}
          <div className="connection" title={connected ? 'Connected' : 'Connecting…'}>
            <span className={`health-dot ${connected ? 'available' : ''}`} />
            {runningCount ? `${runningCount} running` : connected ? 'Local' : 'Offline'}
          </div>
          <button
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={14} />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open threads"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={18} />
          </button>
          <div className="topbar-title">
            <strong>{thread?.title || (activeId ? 'Loading…' : 't3 mini')}</strong>
            {thread ? (
              <span className="chip" title={thread.cwd}>
                <FolderOpen size={12} />
                {folder}
              </span>
            ) : null}
            {thread ? (
              <span className="chip">
                <ProviderMark provider={thread.provider} size={11} />
                {names[thread.provider]}
              </span>
            ) : null}
          </div>
          <div className="topbar-actions">
            {thread ? (
              <>
                <StatusBadge status={thread.status} />
                <button
                  className="icon-button"
                  aria-label="Delete thread"
                  title="Delete thread"
                  onClick={() => void remove()}
                  disabled={active || busy}
                >
                  <Trash2 size={15} />
                </button>
              </>
            ) : null}
          </div>
        </header>
        <div
          className="chat-scroll"
          ref={scrollArea}
          onScroll={() => {
            const element = scrollArea.current
            if (element)
              stickToBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 120
          }}
        >
          {!thread?.messages.length ? (
            <section className="empty-state">
              {thread ? (
                <>
                  <ProviderMark provider={thread.provider} size={22} />
                  <h1>What should we build in {folder}?</h1>
                  <p>
                    {names[thread.provider]} works directly in <code>{thread.cwd}</code>.
                  </p>
                  <div className="starters">
                    {starters.map((starter) => (
                      <button
                        key={starter.title}
                        onClick={() => {
                          setDraft(starter.text)
                          drafts.current.set(thread.id, starter.text)
                          composer.current?.focus()
                        }}
                      >
                        {starter.title}
                      </button>
                    ))}
                  </div>
                </>
              ) : activeId ? null : (
                <>
                  <span className="brand-mark large">t3</span>
                  <h1>Your coding agents, one quiet place.</h1>
                  <p>Pick a project folder and start a thread with Codex or Claude.</p>
                  <button
                    className="primary"
                    disabled={!bootstrap}
                    onClick={() => setCreateOpen(true)}
                  >
                    <SquarePen size={15} />
                    New thread
                    <kbd>{isMac ? '⌘⇧O' : 'Ctrl+Shift+O'}</kbd>
                  </button>
                </>
              )}
            </section>
          ) : (
            <div className="conversation">
              {thread.messages.map((message, index) => (
                <div className="turn" key={message.id}>
                  <article className={`message ${message.role}`}>
                    {message.role === 'user' ? (
                      <div className="user-bubble">{message.text}</div>
                    ) : (
                      <div className="markdown">
                        <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
                      </div>
                    )}
                    <time dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </time>
                  </article>
                  {/* The work log belongs to the latest turn, right after its prompt. */}
                  {index === lastUser ? workLog : null}
                </div>
              ))}
              {lastUser === -1 ? workLog : null}
              {thread.approvals.map((approval) => (
                <section className="approval" key={approval.id}>
                  <div className="approval-title">
                    <ShieldAlert size={16} />
                    <strong>{approval.title}</strong>
                  </div>
                  <pre>{approval.detail}</pre>
                  <div className="approval-actions">
                    <button
                      className="secondary"
                      disabled={busy || !connected}
                      onClick={() => action('approve', { approvalId: approval.id, allow: false })}
                    >
                      Decline
                    </button>
                    <button
                      className="primary"
                      disabled={busy || !connected}
                      onClick={() => action('approve', { approvalId: approval.id, allow: true })}
                    >
                      Allow once
                    </button>
                  </div>
                </section>
              ))}
              {active && !thread.approvals.length ? (
                <div className="thinking" role="status">
                  <span />
                  <span />
                  <span />
                  {labels[thread.status]}…
                </div>
              ) : thread.completedAt && thread.startedAt ? (
                <div className="turn-divider" role="status">
                  <span>
                    {thread.status === 'completed' ? 'Worked' : labels[thread.status]} for{' '}
                    {duration(thread.startedAt, thread.completedAt)}
                  </span>
                </div>
              ) : null}
              {thread.error ? (
                <div className="error-banner" role="alert">
                  {thread.error}
                </div>
              ) : null}
            </div>
          )}
          <div ref={end} />
        </div>
        {thread || !activeId ? (
          <footer className="composer-area">
            {error ? (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError('')}
                >
                  <X size={14} />
                </button>
              </div>
            ) : null}
            {thread ? (
              <form className={`composer ${active ? 'agent-active' : ''}`} onSubmit={send}>
                <textarea
                  ref={composer}
                  aria-label="Message your agent"
                  placeholder={
                    active
                      ? `${names[thread.provider]} is working…`
                      : `Ask ${names[thread.provider]} to build, fix, or explore…`
                  }
                  value={draft}
                  disabled={active}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    drafts.current.set(thread.id, e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                  rows={2}
                />
                <div className="composer-toolbar">
                  <AgentSettingsControls
                    key={thread.id}
                    provider={thread.provider}
                    cwd={thread.cwd}
                    value={{
                      model: thread.model,
                      effort: thread.effort || '',
                      permissionMode: thread.permissionMode || defaultPermission,
                    }}
                    onChange={(settings) => void updateSettings(settings)}
                    disabled={active || busy || !connected}
                  />
                  {active ? (
                    <button
                      className="stop-button"
                      type="button"
                      aria-label="Stop"
                      title="Stop"
                      onClick={() => action('stop')}
                      disabled={busy || !connected}
                    >
                      <Square size={11} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      type="submit"
                      aria-label="Send message"
                      title="Send (Enter)"
                      disabled={!draft.trim() || busy || !connected}
                    >
                      <ArrowUp size={17} />
                    </button>
                  )}
                </div>
              </form>
            ) : null}
          </footer>
        ) : null}
      </main>
      <div className="overlay-stack">
        {showPrompt ? (
          <NotificationPrompt
            onEnable={() => void enableDesktop()}
            onDismiss={() => {
              updateNotify({ ...notifyRef.current, prompted: true })
              setShowPrompt(false)
            }}
          />
        ) : null}
        <Toasts
          events={toasts}
          onOpen={(event) => {
            setToasts((current) => current.filter((item) => item.key !== event.key))
            select(event.thread.id)
          }}
          onDismiss={(key) => setToasts((current) => current.filter((item) => item.key !== key))}
        />
      </div>
      {menu
        ? (() => {
            const target = threads.find((item) => item.id === menu.id)
            if (!target) return null
            return (
              <ThreadMenu
                menu={menu}
                canDelete={!isActive(target.status) && !busy}
                onClose={closeMenu}
                onRename={() => setRenaming({ id: target.id, title: target.title })}
                onCopyPath={() => void navigator.clipboard?.writeText(target.cwd).catch(() => {})}
                onDelete={() => void remove(target)}
              />
            )
          })()
        : null}
      {settingsOpen ? (
        <SettingsDialog
          preferences={notify}
          onChange={(preferences) => {
            updateNotify(preferences)
            if (preferences.prompted) setShowPrompt(false)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {createOpen && bootstrap ? (
        <NewThread
          bootstrap={bootstrap}
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false)
            setThreads((current) => [created, ...current])
            select(created.id)
          }}
        />
      ) : null}
    </div>
  )
}
function NewThread({
  bootstrap,
  onClose,
  onCreated,
}: {
  bootstrap: Bootstrap
  onClose: () => void
  onCreated: (thread: Thread) => void
}) {
  // Start from the user's last choices; fall back to an installed provider.
  const [preferences] = useState(loadPreferences)
  const [provider, setProvider] = useState<Provider>(
    preferences.provider ??
      (bootstrap.providers.claude.installed || !bootstrap.providers.codex.installed
        ? 'claude'
        : 'codex'),
  )
  const [cwd, setCwd] = useState(preferences.cwd || bootstrap.defaultCwd)
  const [settings, setSettings] = useState<AgentSettings>(() => settingsFor(provider, preferences))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  async function browse() {
    setPicking(true)
    setError('')
    try {
      const result = await api<{ path: string | null }>('folders/pick', 'POST', { cwd })
      if (result.path) setCwd(result.path)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setPicking(false)
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault()
    if (picking || busy) return
    setBusy(true)
    setError('')
    try {
      const created = await api<Thread>('threads', 'POST', { provider, cwd, ...settings })
      rememberChoice(provider, settings, created.cwd)
      onCreated(created)
    } catch (error) {
      setError((error as Error).message)
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="new-dialog"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy && !picking) onClose()
      }}
      onClick={(e) => {
        if (e.target === dialog.current && !busy && !picking) onClose()
      }}
    >
      <form onSubmit={create}>
        <div className="dialog-top">
          <h2>New thread</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close new thread"
            disabled={busy || picking}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="field">
          <span className="field-label">Agent</span>
          <div className="provider-options" role="radiogroup" aria-label="Choose provider">
            {(['claude', 'codex'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={provider === item}
                className={provider === item ? 'chosen' : ''}
                onClick={() => {
                  setProvider(item)
                  setSettings(settingsFor(item, preferences))
                }}
              >
                <ProviderMark provider={item} size={14} />
                <span>{names[item]}</span>
                {!bootstrap.providers[item].installed ? (
                  <small>Not installed</small>
                ) : provider === item ? (
                  <Check size={14} />
                ) : null}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="project-folder">
            Project folder
          </label>
          <div className="folder-input-row">
            <input
              id="project-folder"
              autoFocus
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="~/Code/my-project"
              disabled={busy || picking}
              required
            />
            <button className="secondary" type="button" onClick={browse} disabled={busy || picking}>
              <FolderOpen size={14} />
              {picking ? 'Choosing…' : 'Browse'}
            </button>
          </div>
        </div>
        <div className="field">
          <span className="field-label">Settings</span>
          <AgentSettingsControls
            provider={provider}
            cwd={cwd}
            value={settings}
            onChange={setSettings}
            disabled={busy || picking}
            placement="down"
          />
        </div>
        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button className="secondary" type="button" onClick={onClose} disabled={busy || picking}>
            Cancel
          </button>
          <button className="primary" disabled={busy || picking || !cwd.trim()}>
            {busy ? 'Creating…' : 'Create thread'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
