import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowUp,
  Check,
  ChevronRight,
  Circle,
  Copy,
  Folder,
  FolderPlus,
  GitBranch,
  FolderOpen,
  LoaderCircle,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Square,
  Sun,
  SquarePen,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import Markdown, { type Components } from 'react-markdown'
import { Link, useNavigate } from '@tanstack/react-router'
import { AgentSettingsControls, Picker, ProviderMark } from './AgentSettingsControls'
import { defaultPermission, type AgentSettings } from '../agent-settings'
import { loadPreferences, rememberChoice, settingsFor } from '../preferences'
import {
  desktopPermission,
  eventText,
  loadNotificationPreferences,
  loadUnread,
  saveUnread,
  requestDesktopPermission,
  saveNotificationPreferences,
  threadEvents,
  type NotificationPreferences,
  type ThreadEvent,
} from '../notifications'
import { NotificationPrompt, SettingsDialog, Toasts } from './Notifications'
import { ContextMenu, menuPosition, type MenuItem, type MenuPosition } from './ContextMenu'
import { playSound, unlockSound } from '../sound'
import {
  isSidebarHidden,
  saveSidebarHidden,
  loadTheme,
  nextTheme,
  saveTheme,
  themeLabels,
  type Theme,
} from '../theme'
import remarkGfm from 'remark-gfm'
import {
  isActive,
  type Bootstrap,
  type ProjectSummary,
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
// Links in agent replies open in a new tab so the conversation stays put. noopener/noreferrer
// stops the opened page from controlling this tab or seeing its URL. react-markdown's default
// URL filter still drops unsafe schemes such as javascript:.
const markdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) =>
    href?.startsWith('#') ? (
      <a href={href} {...props}>
        {children}
      </a>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    ),
}
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

// The last agent used, else Claude (or Codex when only Codex is installed).
function defaultAgent(bootstrap: Bootstrap, preferences = loadPreferences()): Provider {
  return (
    preferences.provider ??
    (bootstrap.providers.claude.installed || !bootstrap.providers.codex.installed
      ? 'claude'
      : 'codex')
  )
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
function StatusDot({ status, unread = false }: { status: Status; unread?: boolean }) {
  if (status === 'starting' || status === 'working')
    return <LoaderCircle size={12} className="status-spinner" aria-label={labels[status]} />
  if (unread && status !== 'waiting')
    return (
      <span
        className={`status-dot unread ${status}`}
        title={`${labels[status]} · not viewed yet`}
      />
    )
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
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Wide screens hide the sidebar in place; phones use the slide-out drawer instead.
  const [sidebarHidden, setSidebarHidden] = useState(false)
  useEffect(() => setSidebarHidden(isSidebarHidden()), [])
  function toggleSidebar() {
    if (window.matchMedia('(max-width: 760px)').matches) return setSidebarOpen((open) => !open)
    const hidden = !isSidebarHidden()
    saveSidebarHidden(hidden)
    setSidebarHidden(hidden)
  }
  const toggleSidebarRef = useRef(toggleSidebar)
  toggleSidebarRef.current = toggleSidebar
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [workLogOpen, setWorkLogOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const content = useRef<HTMLDivElement>(null)
  const [git, setGit] = useState<{ branch: string | null; detached?: boolean } | null>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const composer = useRef<HTMLTextAreaElement>(null)
  const drafts = useRef(new Map<string, string>())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 'system' on the server render; the saved choice is read after mount (already applied by the head script).
  const [theme, setTheme] = useState<Theme>('system')
  useEffect(() => setTheme(loadTheme()), [])
  function changeTheme(next: Theme) {
    setTheme(next)
    saveTheme(next)
  }
  const [menu, setMenu] = useState<
    | { kind: 'thread'; id: string; position: MenuPosition }
    | { kind: 'project'; path: string; position: MenuPosition }
    | null
  >(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  // Where the new-thread dialog starts; null while closed.
  const [newThreadProject, setNewThreadProject] = useState<string | null>(null)
  // Add project can return to the new-thread dialog with the added folder selected.
  const [addProject, setAddProject] = useState<null | 'sidebar' | 'new-thread'>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [toasts, setToasts] = useState<ThreadEvent[]>([])
  const [showPrompt, setShowPrompt] = useState(false)
  // Read from localStorage after mount so the server render and first client render match.
  const [notify, setNotify] = useState<NotificationPreferences>({
    desktop: false,
    inApp: true,
    sound: true,
    soundName: 'chime',
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
        setProjects(data.projects ?? [])
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
        // Optional: a server started before projects existed omits it until restarted.
        projects?: ProjectSummary[]
        thread: Thread | null
        persistenceError?: string
      }
      setProjects(data.projects ?? [])
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
  // The thread's git branch. Refreshed when the thread opens, after each turn (the agent may
  // switch branches), and when you come back to the window.
  const turnActive = thread ? isActive(thread.status) : false
  useEffect(() => {
    setGit(null)
    if (!activeId) return
    const controller = new AbortController()
    const load = () =>
      api<{ branch: string | null; detached?: boolean }>(
        `threads/${activeId}/git`,
        'GET',
        undefined,
        controller.signal,
      )
        .then(setGit)
        .catch(() => {})
    if (!turnActive) void load()
    window.addEventListener('focus', load)
    return () => {
      controller.abort()
      window.removeEventListener('focus', load)
    }
  }, [activeId, turnActive])
  useLayoutEffect(() => {
    // Keep the chat pinned to the bottom while it grows (streamed text, work log, status
    // lines) or while the chat area shrinks (a taller composer), unless the user scrolled up.
    // Only the chat container scrolls; scrollIntoView would also shift the outer layout.
    const element = scrollArea.current
    if (!element) return
    const pin = () => {
      if (stickToBottom.current) element.scrollTop = element.scrollHeight
    }
    pin()
    const observer = new ResizeObserver(pin)
    observer.observe(element)
    if (content.current) observer.observe(content.current)
    return () => observer.disconnect()
  }, [activeId])
  useEffect(() => {
    const saved = loadNotificationPreferences()
    const permission = desktopPermission()
    setNotify(saved)
    setShowPrompt(!saved.prompted && (permission === 'default' || permission === 'granted'))
  }, [])
  useEffect(() => {
    // Opening a thread clears its toasts and its unread mark.
    if (!activeId) return
    setToasts((current) => current.filter((item) => item.thread.id !== activeId))
    markRead(activeId)
  }, [activeId])
  const [unread, setUnread] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    // The thread open on page load counts as seen.
    const saved = loadUnread()
    if (selectedId.current && saved.delete(selectedId.current)) saveUnread(saved)
    setUnread(saved)
  }, [])
  function markRead(id: string) {
    setUnread((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      saveUnread(next)
      return next
    })
  }
  useEffect(() => {
    // Coming back to the window counts as seeing the thread that's open.
    const onFocus = () => {
      if (selectedId.current && document.visibilityState === 'visible') markRead(selectedId.current)
    }
    // Audio needs a prior user gesture; arm it on the first interaction.
    window.addEventListener('pointerdown', unlockSound, { once: true })
    window.addEventListener('keydown', unlockSound, { once: true })
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('pointerdown', unlockSound)
      window.removeEventListener('keydown', unlockSound)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])
  function announce(events: ThreadEvent[]) {
    if (!events.length) return
    const focused = document.visibilityState === 'visible' && document.hasFocus()
    const preferences = notifyRef.current
    const finished = events.filter((event) => event.kind === 'completed' || event.kind === 'failed')
    if (preferences.sound && events.some((event) => event.kind === 'completed'))
      playSound(preferences.soundName)
    const unseen = finished.filter((event) => !(focused && event.thread.id === selectedId.current))
    if (unseen.length)
      setUnread((current) => {
        const next = new Set(current)
        for (const event of unseen) next.add(event.thread.id)
        saveUnread(next)
        return next
      })
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
    // ⌘⇧O / Ctrl+Shift+O starts a new thread, matching t3code. ⌘S / Ctrl+S toggles the
    // sidebar (in place of the browser's Save Page, which has no use here).
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        if (bootstrap) openNewThreadRef.current()
      } else if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        toggleSidebarRef.current()
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
      if (!element || element.disabled || newThreadProject !== null || addProject) return false
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
  }, [newThreadProject, addProject, activeId])
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
  async function updateSettings(settings: AgentSettings, provider = thread?.provider) {
    if (!activeId || !thread || busy) return
    setBusy(true)
    setError('')
    try {
      const updated = await api<Thread>(`threads/${activeId}/settings`, 'POST', {
        ...settings,
        provider,
      })
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
    const provider = bootstrap ? defaultAgent(bootstrap, preferences) : 'claude'
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
      markRead(target.id)
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
  // Opens the new-thread dialog on the project you were last active in: the open thread's
  // project, else the most recently active project. With no projects yet, add one first.
  function openNewThread(path?: string) {
    if (!bootstrap) return
    const initial = path ?? thread?.cwd ?? projects[0]?.path
    if (!initial) return setAddProject('new-thread')
    setNewThreadProject(initial)
  }
  const openNewThreadRef = useRef(openNewThread)
  openNewThreadRef.current = openNewThread
  async function removeProject(path: string) {
    try {
      await api('projects', 'DELETE', { path })
      setProjects((current) => current.filter((project) => project.path !== path))
    } catch (error) {
      setError((error as Error).message)
    }
  }
  const copyPath = (path: string) => void navigator.clipboard?.writeText(path).catch(() => {})
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
  // Projects arrive most recently active first; threads within them newest first. A thread
  // created a moment ago may arrive before its project does, so fall back to thread folders.
  const projectPaths = [
    ...new Set([
      ...threads
        .map((item) => item.cwd)
        .filter((cwd) => !projects.some((project) => project.path === cwd)),
      ...projects.map((project) => project.path),
    ]),
  ]
  const groups = projectPaths
    .map((path) => ({ path, items: visibleThreads.filter((item) => item.cwd === path) }))
    .filter((group) => !query || group.items.length || group.path.toLowerCase().includes(query))
  const active = thread ? isActive(thread.status) : false
  const folder = thread ? folderName(thread.cwd) : undefined
  const runningCount = threads.filter((item) => isActive(item.status)).length
  const missingClis = bootstrap
    ? (['claude', 'codex'] as const)
        .filter((provider) => !bootstrap.providers[provider].installed)
        .map((provider) => names[provider])
    : []
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
          <div className="sidebar-header-actions">
            <button
              className="icon-button"
              onClick={() => openNewThread()}
              disabled={!bootstrap}
              aria-label="New thread"
              title={`New thread (${isMac ? '⌘⇧O' : 'Ctrl+Shift+O'})`}
            >
              <SquarePen size={15} />
            </button>
            <button
              className="icon-button"
              onClick={() => setAddProject('sidebar')}
              disabled={!bootstrap}
              aria-label="Add project"
              title="Add project"
            >
              <FolderPlus size={15} />
            </button>
            <button
              className="icon-button"
              onClick={toggleSidebar}
              aria-label="Hide sidebar"
              title={`Hide sidebar (${isMac ? '⌘S' : 'Ctrl+S'})`}
            >
              <PanelLeftClose size={15} />
            </button>
          </div>
        </div>
        <label className="search">
          <Search size={14} />
          <input
            aria-label="Search threads and projects"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <nav className="thread-list" aria-label="Threads">
          {groups.map(({ path: cwd, items }) => (
            <section className="project" key={cwd}>
              <div
                className="project-header"
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ kind: 'project', path: cwd, position: menuPosition(event) })
                }}
              >
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
                        <StatusDot status={item.status} unread={unread.has(item.id)} />
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
                        className={`thread-row ${activeId === item.id ? 'selected' : ''} ${unread.has(item.id) ? 'unread' : ''}`}
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
                          setMenu({ kind: 'thread', id: item.id, position: menuPosition(event) })
                        }}
                        onDoubleClick={(event) => {
                          event.preventDefault()
                          setRenaming({ id: item.id, title: item.title })
                        }}
                        aria-disabled={busy}
                        aria-current={activeId === item.id ? 'page' : undefined}
                      >
                        <StatusDot status={item.status} unread={unread.has(item.id)} />
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
              {!collapsed[cwd] && !items.length && !query ? (
                <button
                  className="thread-row empty-project"
                  disabled={busy}
                  onClick={() => openNewThread(cwd)}
                >
                  <Plus size={12} />
                  Start a thread
                </button>
              ) : null}
            </section>
          ))}
          {!groups.length ? (
            <div className="empty-sidebar">
              {search
                ? 'Nothing matches your search.'
                : bootstrap
                  ? 'Add a project folder to get started.'
                  : 'Loading…'}
            </div>
          ) : null}
        </nav>
        <div className="sidebar-footer">
          <div
            className="connection"
            role="status"
            title={connected ? 'Connected to the local server' : 'Reconnecting to the local server'}
          >
            <span className={`health-dot ${connected ? 'available' : ''}`} />
            {runningCount ? `${runningCount} running` : connected ? 'Connected' : 'Connecting…'}
          </div>
          {missingClis.length ? (
            <button
              className="icon-button footer-warning"
              aria-label={`${missingClis.join(' and ')} CLI not found. Open settings`}
              title={`${missingClis.join(' and ')} CLI not found`}
              onClick={() => setSettingsOpen(true)}
            >
              <TriangleAlert size={14} />
            </button>
          ) : null}
          <button
            className="icon-button"
            aria-label={`Theme: ${themeLabels[theme]}. Switch to ${themeLabels[nextTheme(theme)]}`}
            title={`Theme: ${themeLabels[theme]}`}
            onClick={() => changeTheme(nextTheme(theme))}
          >
            {theme === 'light' ? (
              <Sun size={14} />
            ) : theme === 'dark' ? (
              <Moon size={14} />
            ) : (
              <Monitor size={14} />
            )}
          </button>
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
          {sidebarHidden ? (
            <button
              className="icon-button show-sidebar"
              aria-label="Show sidebar"
              title={`Show sidebar (${isMac ? '⌘S' : 'Ctrl+S'})`}
              onClick={toggleSidebar}
            >
              <PanelLeftOpen size={16} />
            </button>
          ) : null}
          <div className="topbar-title">
            <strong>{thread?.title || (activeId ? 'Loading…' : 't3 mini')}</strong>
            {thread ? (
              <span className="chip" title={thread.cwd}>
                <FolderOpen size={12} />
                {folder}
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
          <div className="chat-content" ref={content}>
            {!thread?.messages.length ? (
              <section className="empty-state">
                {thread ? (
                  <>
                    <ProviderMark provider={thread.provider} size={28} />
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
                    <p>Pick a project folder and start a thread with Claude or Codex.</p>
                    <div className="empty-actions">
                      <button
                        className="primary"
                        disabled={!bootstrap}
                        onClick={() => openNewThread()}
                      >
                        <SquarePen size={15} />
                        New thread
                        <kbd>{isMac ? '⌘⇧O' : 'Ctrl+Shift+O'}</kbd>
                      </button>
                      <button
                        className="secondary"
                        disabled={!bootstrap}
                        onClick={() => setAddProject('sidebar')}
                      >
                        <FolderPlus size={15} />
                        Add project
                      </button>
                    </div>
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
                          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {message.text}
                          </Markdown>
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
          </div>
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
                    agent={
                      bootstrap
                        ? {
                            installed: {
                              claude: bootstrap.providers.claude.installed,
                              codex: bootstrap.providers.codex.installed,
                            },
                            locked: thread.messages.length > 0 || Boolean(thread.sessionId),
                            // Switching agents brings back that agent's last-used settings.
                            onChange: (provider) => {
                              if (provider !== thread.provider)
                                void updateSettings(settingsFor(provider), provider)
                            },
                          }
                        : undefined
                    }
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
            {thread && git?.branch ? (
              <div className="composer-meta">
                <span
                  className="git-branch"
                  title={git.detached ? `Detached HEAD at ${git.branch}` : `Branch ${git.branch}`}
                >
                  <GitBranch size={12} />
                  <span>{git.detached ? `detached at ${git.branch}` : git.branch}</span>
                </span>
              </div>
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
            let items: MenuItem[] = []
            if (menu.kind === 'thread') {
              const target = threads.find((item) => item.id === menu.id)
              if (!target) return null
              items = [
                {
                  label: 'Rename',
                  icon: <Pencil size={14} />,
                  onSelect: () => setRenaming({ id: target.id, title: target.title }),
                },
                {
                  label: 'Copy project path',
                  icon: <Copy size={14} />,
                  onSelect: () => copyPath(target.cwd),
                },
                'separator',
                {
                  label: 'Delete',
                  icon: <Trash2 size={14} />,
                  danger: true,
                  disabled: isActive(target.status) || busy,
                  title: isActive(target.status)
                    ? 'Stop the agent before deleting this thread.'
                    : undefined,
                  onSelect: () => void remove(target),
                },
              ]
            } else {
              const path = menu.path
              const hasThreads = threads.some((item) => item.cwd === path)
              items = [
                {
                  label: 'New thread here',
                  icon: <SquarePen size={14} />,
                  onSelect: () => openNewThread(path),
                },
                { label: 'Copy path', icon: <Copy size={14} />, onSelect: () => copyPath(path) },
                'separator',
                {
                  label: 'Remove project',
                  icon: <Trash2 size={14} />,
                  danger: true,
                  disabled: hasThreads,
                  title: hasThreads ? 'Delete this project’s threads first.' : undefined,
                  onSelect: () => void removeProject(path),
                },
              ]
            }
            return (
              <ContextMenu
                position={menu.position}
                label={menu.kind === 'thread' ? 'Thread actions' : 'Project actions'}
                items={items}
                onClose={closeMenu}
              />
            )
          })()
        : null}
      {settingsOpen ? (
        <SettingsDialog
          preferences={notify}
          providers={bootstrap?.providers}
          theme={theme}
          onThemeChange={changeTheme}
          onChange={(preferences) => {
            updateNotify(preferences)
            if (preferences.prompted) setShowPrompt(false)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {newThreadProject !== null && bootstrap ? (
        <NewThread
          bootstrap={bootstrap}
          projects={projectPaths}
          initialProject={newThreadProject}
          onAddProject={() => {
            setNewThreadProject(null)
            setAddProject('new-thread')
          }}
          onClose={() => setNewThreadProject(null)}
          onCreated={(created) => {
            setNewThreadProject(null)
            setThreads((current) => [created, ...current])
            select(created.id)
          }}
        />
      ) : null}
      {addProject && bootstrap ? (
        <AddProject
          initialPath={loadPreferences().cwd || bootstrap.defaultCwd}
          onClose={() => setAddProject(null)}
          onAdded={(project) => {
            setProjects((current) => [
              project,
              ...current.filter((item) => item.path !== project.path),
            ])
            setCollapsed((current) => ({ ...current, [project.path]: false }))
            // From the new-thread dialog, go back to it with the new project selected.
            if (addProject === 'new-thread') setNewThreadProject(project.path)
            setAddProject(null)
          }}
        />
      ) : null}
    </div>
  )
}
function NewThread({
  bootstrap,
  projects,
  initialProject,
  onAddProject,
  onClose,
  onCreated,
}: {
  bootstrap: Bootstrap
  projects: string[]
  initialProject: string
  onAddProject: () => void
  onClose: () => void
  onCreated: (thread: Thread) => void
}) {
  const [cwd, setCwd] = useState(initialProject)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  async function create(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      // Agent, model, effort, and permissions start from your last choices; change them in the
      // composer before sending.
      const preferences = loadPreferences()
      const provider = defaultAgent(bootstrap, preferences)
      const settings = settingsFor(provider, preferences)
      const created = await api<Thread>('threads', 'POST', { provider, cwd, ...settings })
      rememberChoice(provider, settings, created.cwd)
      onCreated(created)
    } catch (error) {
      setError((error as Error).message)
      setBusy(false)
    }
  }
  const options = (projects.includes(cwd) ? projects : [cwd, ...projects]).map((path) => ({
    value: path,
    label: folderName(path),
    description: path,
  }))
  return (
    <dialog
      ref={dialog}
      className="new-dialog"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
      onClick={(e) => {
        if (e.target === dialog.current && !busy) onClose()
      }}
    >
      <form onSubmit={create}>
        <div className="dialog-top">
          <h2>New thread</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close new thread"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="field project-field">
          <span className="field-label">Project</span>
          <Picker
            label="Project"
            icon={<Folder size={14} />}
            text={folderName(cwd)}
            value={cwd}
            options={options}
            disabled={busy}
            placement="down"
            onSelect={setCwd}
            footer={
              <button type="button" className="picker-footer-action" onClick={onAddProject}>
                <FolderPlus size={14} />
                Add project…
              </button>
            }
          />
          <small className="field-hint" title={cwd}>
            {cwd}
          </small>
        </div>
        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" autoFocus disabled={busy}>
            {busy ? 'Creating…' : 'Create thread'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
function AddProject({
  initialPath,
  onClose,
  onAdded,
}: {
  initialPath: string
  onClose: () => void
  onAdded: (project: ProjectSummary) => void
}) {
  const [path, setPath] = useState(initialPath)
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
      const result = await api<{ path: string | null }>('folders/pick', 'POST', { cwd: path })
      if (result.path) setPath(result.path)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setPicking(false)
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault()
    if (busy || picking) return
    setBusy(true)
    setError('')
    try {
      onAdded(await api<ProjectSummary>('projects', 'POST', { path }))
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
      <form onSubmit={add}>
        <div className="dialog-top">
          <h2>Add project</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close add project"
            disabled={busy || picking}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="project-folder">
            Project folder
          </label>
          <div className="folder-input-row">
            <input
              id="project-folder"
              autoFocus
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="~/Code/my-project"
              disabled={busy || picking}
              required
            />
            <button className="secondary" type="button" onClick={browse} disabled={busy || picking}>
              <FolderOpen size={14} />
              {picking ? 'Choosing…' : 'Browse'}
            </button>
          </div>
          <small className="field-hint">
            {picking
              ? 'Choose a folder in the macOS window, or cancel to return.'
              : 'An absolute path or ~/… on this machine. Agents can edit files in this folder.'}
          </small>
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
          <button className="primary" disabled={busy || picking || !path.trim()}>
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
