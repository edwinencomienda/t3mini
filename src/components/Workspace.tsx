import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  ArrowUp,
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  Copy,
  EllipsisVertical,
  ExternalLink,
  Folder,
  FolderPlus,
  FileUp,
  FileDiff,
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
  Smartphone,
  Sparkles,
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
import { VSCodeIcon } from './ProviderIcon'
import { defaultPermission, type AgentSettings } from '../agent-settings'
import { loadPreferences, rememberChoice, settingsFor } from '../preferences'
import {
  desktopPermission,
  eventText,
  forgetTab,
  isNotifyingTab,
  loadNotificationPreferences,
  markTabAlive,
  markTabVisited,
  tabHeartbeatMs,
  loadUnread,
  saveUnread,
  requestDesktopPermission,
  saveNotificationPreferences,
  threadEvents,
  type NotificationPreferences,
  type ThreadEvent,
} from '../notifications'
import { NotificationPrompt, SettingsDialog, Toasts } from './Notifications'
import { ProviderUpdates } from './ProviderUpdates'
import { DiffPanel } from './DiffPanel'
import { Blocks } from './blocks'
import { ProcessIndicator } from './Processes'
import type { ProcessInfo } from '../server/processes'
import { ImagePreview, previewOnClick } from './ImagePreview'
import { DictationButton, dictationSupported } from './Dictation'
import { Modal, ModalTitle } from './Modal'
import { ContextMenu, menuPosition, type MenuItem, type MenuPosition } from './ContextMenu'
import { playSound, unlockSound } from '../sound'
import {
  basename,
  droppedPaths,
  formatPath,
  hasFiles,
  copyText,
  isAttachableImage,
  prepareImage,
  randomId,
  uploadFile,
  type PendingAttachment,
} from '../attachments'
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
  editableMessage,
  isActive,
  type Bootstrap,
  type GitInfo,
  type Message,
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
// A code block in a reply, with a button that copies its text (works on phones too: copyText
// falls back to a hidden textarea where the Clipboard API isn't allowed).
function CodeBlock({ children, ...props }: React.ComponentProps<'pre'>) {
  const block = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="code-block">
      <pre ref={block} {...props}>
        {children}
      </pre>
      <button
        type="button"
        className="icon-button code-copy"
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() =>
          void copyText((block.current?.textContent ?? '').replace(/\n$/, '')).then(
            () => setCopied(true),
            () => {},
          )
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}
// Links in agent replies open in a new tab so the conversation stays put. noopener/noreferrer
// stops the opened page from controlling this tab or seeing its URL. react-markdown's default
// URL filter still drops unsafe schemes such as javascript:.
const markdownComponents: Components = {
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
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
// Markdown is the costliest part of a render. Each message re-parses only when its own text
// changes, so typing in the composer (which re-renders the page) stays instant in long threads.
const markdownPlugins = [remarkGfm]
const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={markdownPlugins} components={markdownComponents}>
      {text}
    </Markdown>
  )
})
// One message. Live updates parse a fresh copy of the thread every time, so rows compare by
// content rather than identity; unchanged messages skip rendering entirely.
const MessageView = memo(
  function MessageView({ message }: { message: Message }) {
    return (
      <article className={`message ${message.role}`}>
        {message.role === 'user' ? (
          <>
            {message.attachments?.length ? (
              <div className="message-images">
                {message.attachments.map((item) => (
                  <a
                    key={item.id}
                    href={`/api/uploads/${encodeURIComponent(item.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={item.name}
                    onClick={previewOnClick({
                      src: `/api/uploads/${encodeURIComponent(item.id)}`,
                      alt: item.name,
                      caption: item.name,
                    })}
                  >
                    <img
                      src={`/api/uploads/${encodeURIComponent(item.id)}`}
                      alt={item.name}
                      loading="lazy"
                      decoding="async"
                    />
                  </a>
                ))}
              </div>
            ) : null}
            {message.text ? <div className="user-bubble">{message.text}</div> : null}
            {message.queued ? (
              <span className="message-note">Queued · sends when the current turn ends</span>
            ) : message.unsent ? (
              <span className="message-note">Not sent · the turn was stopped</span>
            ) : message.rewindFailed ? (
              <span className="message-note">
                Sent as a follow-up · the agent couldn’t drop the earlier attempt
              </span>
            ) : null}
          </>
        ) : (
          <>
            {message.text ? (
              <div className="markdown">
                <MessageMarkdown text={message.text} />
              </div>
            ) : null}
            {/* Images and other content added by tools during this reply. */}
            {message.blocks?.length ? <Blocks blocks={message.blocks} /> : null}
          </>
        )}
        <time dateTime={message.createdAt}>
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </time>
      </article>
    )
  },
  (before, after) =>
    before.message.id === after.message.id &&
    before.message.text === after.message.text &&
    before.message.queued === after.message.queued &&
    before.message.unsent === after.message.unsent &&
    before.message.createdAt === after.message.createdAt &&
    (before.message.attachments?.length ?? 0) === (after.message.attachments?.length ?? 0) &&
    (before.message.blocks?.length ?? 0) === (after.message.blocks?.length ?? 0),
)
// The composer grows with its text (or a live dictation preview) up to this height, then scrolls.
const composerMaxHeight = 240
const folderName = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) || '/'
// A project's name: the one you gave it in the sidebar, else its folder name.
const projectLabel = (projects: ProjectSummary[], path: string) =>
  projects.find((project) => project.path === path)?.name || folderName(path)
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
  // The status rides along so callers can tell "not found" from other failures.
  if (!response.ok)
    throw Object.assign(new Error(data.error || 'Request failed.'), { status: response.status })
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
// Shown in the header only while the agent is running (including waiting on an approval).
// Finished, stopped, failed, and idle threads keep the header clean; the chat shows the outcome.
function StatusBadge({ status }: { status: Status }) {
  if (!isActive(status)) return null
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
  // Collapsed projects in the sidebar, remembered across reloads.
  const [collapsed, setCollapsedState] = useState<Record<string, boolean>>({})
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('t3-mini:collapsed-projects') || '[]')
      if (Array.isArray(saved))
        setCollapsedState(
          Object.fromEntries(
            saved.filter((path) => typeof path === 'string').map((path) => [path, true]),
          ),
        )
    } catch {
      // Everything expanded by default.
    }
  }, [])
  function setCollapsed(
    update:
      Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>),
  ) {
    setCollapsedState((current) => {
      const next = typeof update === 'function' ? update(current) : update
      try {
        const paths = Object.keys(next).filter((path) => next[path])
        localStorage.setItem('t3-mini:collapsed-projects', JSON.stringify(paths))
      } catch {
        // Still applies for this session.
      }
      return next
    })
  }
  // The composer's text lives in the textarea itself (uncontrolled), so typing doesn't
  // re-render the page; the page only tracks whether there's anything to send.
  const draftText = useRef('')
  const [hasDraft, setHasDraft] = useState(false)
  function resizeComposer() {
    const element = composer.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, composerMaxHeight)}px`
  }
  // Called on every keystroke: only the "anything to send?" flag can trigger a render.
  function draftChanged(text: string) {
    draftText.current = text
    if (activeId) drafts.current.set(activeId, text)
    setHasDraft(Boolean(text.trim()))
    resizeComposer()
  }
  // Replaces the composer's text from code (switching threads, starters, after sending).
  function setDraft(text: string) {
    draftText.current = text
    const element = composer.current
    if (element && element.value !== text) element.value = text
    setHasDraft(Boolean(text.trim()))
    resizeComposer()
  }
  const [busy, setBusy] = useState(false)
  const [workLogOpen, setWorkLogOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const content = useRef<HTMLDivElement>(null)
  // Images waiting to be sent, per thread so switching threads keeps them.
  const [pending, setPending] = useState<Record<string, PendingAttachment[]>>({})
  // ↑ / ↓ in the composer walk through what you sent in this thread. `index` is the position
  // in that list; `text` is what was filled in, so typing over it hands the arrows back.
  const recalled = useRef<{ thread: string; index: number; text: string } | null>(null)
  // The message being edited (recalled after a stopped or failed turn); sending replaces it.
  const [editing, setEditing] = useState<string | null>(null)
  // Recall and editing belong to one thread; switching threads ends them.
  useEffect(() => {
    recalled.current = null
    setEditing(null)
  }, [activeId])
  const [dragging, setDragging] = useState(false)
  // Whether the changes panel is open, remembered per project.
  const [diffOpenIn, setDiffOpenIn] = useState<Record<string, boolean>>({})
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('t3-mini:diff-open-projects') || '{}')
      if (saved && typeof saved === 'object') setDiffOpenIn(saved as Record<string, boolean>)
    } catch {
      // Closed by default.
    }
  }, [])
  function toggleDiff(open: boolean) {
    if (!activeCwd) return
    const next = { ...diffOpenIn, [activeCwd]: open }
    if (!open) delete next[activeCwd]
    setDiffOpenIn(next)
    try {
      localStorage.setItem('t3-mini:diff-open-projects', JSON.stringify(next))
    } catch {
      // The panel still toggles for this session.
    }
  }
  const filePicker = useRef<HTMLInputElement>(null)
  // Last known state of each visited thread and each project's git branch, shown instantly on
  // switching so the layout doesn't blank out and pop back in while fresh data loads.
  const threadCache = useRef(new Map<string, Thread>())
  const notice = useRef<string | undefined>(undefined)
  const gitCache = useRef(new Map<string, GitInfo>())
  const [git, setGit] = useState<GitInfo | null>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const settleUntil = useRef(0)
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
  const projectName = (path: string) => projectLabel(projects, path)
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  // Where the new-thread dialog starts; null while closed.
  const [newThreadProject, setNewThreadProject] = useState<string | null>(null)
  const [addProject, setAddProject] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [renamingProject, setRenamingProject] = useState<{ path: string; name: string } | null>(
    null,
  )
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
    // Show the cached copy right away (connection status stays as is; the new stream takes over).
    setThread(activeId ? (threadCache.current.get(activeId) ?? null) : null)
    // A note left by the previous view (e.g. "That thread was deleted.") survives the switch.
    setError(notice.current ?? '')
    notice.current = undefined
    const controller = new AbortController()
    // Load the thread directly too: a first visit shows up without waiting for the stream, and
    // a deleted thread gets a clear error.
    if (activeId)
      api<Thread>(`threads/${activeId}`, 'GET', undefined, controller.signal)
        .then((loaded) => {
          threadCache.current.set(loaded.id, loaded)
          setThread((current) => (current?.id === loaded.id ? current : loaded))
        })
        .catch((error: Error & { status?: number }) => {
          if (controller.signal.aborted) return
          if (error.status === 404) leave()
          else setError(error.message)
        })
    // The open thread was deleted (here, on another device, or before this link was opened):
    // go home like the desktop does after deleting, instead of waiting on a thread that's gone.
    let gone = false
    const leave = () => {
      if (gone || !activeId) return
      gone = true
      threadCache.current.delete(activeId)
      drafts.current.delete(activeId)
      events?.close()
      clearTimeout(retry)
      notice.current = 'That thread was deleted.'
      void navigate({ to: '/', replace: true })
    }
    // The browser retries a dropped stream by itself, but gives up for good if a retry gets an
    // error response (for example while the server restarts). Reconnect ourselves with a
    // growing delay so the page never sits on stale state.
    let events: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const connect = () => {
      events = new EventSource(
        `/api/events${activeId ? `?thread=${encodeURIComponent(activeId)}` : ''}`,
      )
      events.onopen = () => {
        attempts = 0
        setConnected(true)
      }
      events.onerror = () => {
        setConnected(false)
        if (events?.readyState !== EventSource.CLOSED) return
        events.close()
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10_000))
      }
      events.onmessage = (event) => {
        const data = JSON.parse(event.data) as {
          threads: ThreadSummary[]
          // Optional: a server started before projects existed omits it until restarted.
          projects?: ProjectSummary[]
          thread: Thread | null
          processes?: ProcessInfo[]
          persistenceError?: string
        }
        setProjects(data.projects ?? [])
        setProcesses(data.processes ?? [])
        announce(threadEvents(statuses.current, data.threads), data.projects ?? [])
        statuses.current = new Map(data.threads.map((item) => [item.id, item.status]))
        setThreads(data.threads)
        if (activeId && !data.thread && !data.threads.some((item) => item.id === activeId)) {
          leave()
          return
        }
        if (data.thread) threadCache.current.set(data.thread.id, data.thread)
        setThread(data.thread)
        if (data.persistenceError) setError(data.persistenceError)
      }
    }
    connect()
    // Coming back to a tab whose stream was given up on reconnects right away.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || events?.readyState !== EventSource.CLOSED)
        return
      clearTimeout(retry)
      attempts = 0
      connect()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      controller.abort()
      clearTimeout(retry)
      events?.close()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [activeId])
  // The thread's git branch. Refreshed when the thread opens, after each turn (the agent may
  // switch branches), and when you come back to the window.
  const turnActive = thread ? isActive(thread.status) : false
  // The open thread's project, known from the sidebar list even before the thread loads.
  const activeCwd = thread?.cwd ?? threads.find((item) => item.id === activeId)?.cwd
  useEffect(() => {
    setGit(activeCwd ? (gitCache.current.get(activeCwd) ?? null) : null)
    if (!activeId || !activeCwd) return
    const controller = new AbortController()
    const load = () =>
      api<GitInfo>(`threads/${activeId}/git`, 'GET', undefined, controller.signal)
        .then((info) => {
          gitCache.current.set(activeCwd, info)
          setGit(info)
        })
        .catch(() => {})
    if (!turnActive) void load()
    window.addEventListener('focus', load)
    return () => {
      controller.abort()
      window.removeEventListener('focus', load)
    }
  }, [activeId, activeCwd, turnActive])
  useLayoutEffect(() => {
    // Keep the chat pinned to the bottom while it grows (streamed text, work log, status
    // lines) or while the chat area shrinks (a taller composer), unless the user scrolled up.
    // Only the chat container scrolls; scrollIntoView would also shift the outer layout.
    const element = scrollArea.current
    if (!element) return
    // Opening a thread lands at the bottom: for a moment it stays pinned no matter what, while
    // messages load, images size themselves, and phone scroll momentum settles.
    stickToBottom.current = true
    settleUntil.current = Date.now() + 900
    const pin = () => {
      if (stickToBottom.current || Date.now() < settleUntil.current)
        element.scrollTop = element.scrollHeight
    }
    pin()
    let frames = 0
    let frame = requestAnimationFrame(function repin() {
      pin()
      if (++frames < 30) frame = requestAnimationFrame(repin)
    })
    const observer = new ResizeObserver(pin)
    observer.observe(element)
    if (content.current) observer.observe(content.current)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [activeId])
  // The thread's messages arriving (first visit, or the live copy replacing the cached one)
  // re-pins within the same settle window.
  const loadedThread = thread?.id
  useLayoutEffect(() => {
    const element = scrollArea.current
    if (!element || !loadedThread) return
    if (stickToBottom.current || Date.now() < settleUntil.current)
      element.scrollTop = element.scrollHeight
  }, [loadedThread])
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
    // Coming back to the window counts as seeing the thread that's open, and makes this the
    // tab that notifies.
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return
      markTabVisited()
      if (selectedId.current) markRead(selectedId.current)
    }
    if (document.visibilityState === 'visible' && document.hasFocus()) markTabVisited()
    else markTabAlive()
    const heartbeat = setInterval(markTabAlive, tabHeartbeatMs)
    // pageshow: coming back from the back/forward cache, after pagehide forgot this tab.
    const onShow = () => (document.hasFocus() ? markTabVisited() : markTabAlive())
    // Audio needs a prior user gesture; arm it on the first interaction.
    window.addEventListener('pointerdown', unlockSound, { once: true })
    window.addEventListener('keydown', unlockSound, { once: true })
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('pagehide', forgetTab)
    window.addEventListener('pageshow', onShow)
    return () => {
      clearInterval(heartbeat)
      window.removeEventListener('pointerdown', unlockSound)
      window.removeEventListener('keydown', unlockSound)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('pagehide', forgetTab)
      window.removeEventListener('pageshow', onShow)
    }
  }, [])
  // `projects` comes with the same live update, so notifications use current project names.
  function announce(events: ThreadEvent[], projects: ProjectSummary[]) {
    if (!events.length) return
    const visible = document.visibilityState === 'visible'
    // Phone browsers (iOS Safari especially) often report no focus while you're looking right
    // at the page, so on touch screens a visible page counts as being watched.
    const focused =
      visible && (document.hasFocus() || window.matchMedia('(pointer: coarse)').matches)
    const preferences = notifyRef.current
    // With several tabs open, only the one you used last chimes and sends desktop notifications.
    const notifier = isNotifyingTab()
    const finished = events.filter((event) => event.kind === 'completed' || event.kind === 'failed')
    if (notifier && preferences.sound && events.some((event) => event.kind === 'completed'))
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
      // No toast for the thread already on screen, focused or not.
      const onScreen = visible && event.thread.id === selectedId.current
      if (preferences.inApp && !onScreen)
        setToasts((current) => [
          ...current.filter((item) => item.thread.id !== event.thread.id),
          event,
        ])
      if (notifier && preferences.desktop && !focused && desktopPermission() === 'granted') {
        try {
          // e.g. "t3-mini · Claude finished", with the thread's title underneath.
          const notification = new Notification(
            `${projectLabel(projects, event.thread.cwd)} · ${names[event.thread.provider]} ${eventText[event.kind].toLowerCase()}`,
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
    // ⇧⌘O / Ctrl+Shift+O starts a new thread, matching t3code. ⌘S / Ctrl+S toggles the
    // sidebar (in place of the browser's Save Page, which has no use here).
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        if (bootstrap) openNewThreadRef.current()
      } else if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        toggleSidebarRef.current()
      } else if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd') {
        // In place of the browser's bookmark shortcut, which has no use here.
        event.preventDefault()
        toggleChangesRef.current()
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
      return !target.closest(
        'input, textarea, select, [contenteditable], [role="dialog"], [role="menu"]',
      )
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
      const files = [...(event.clipboardData?.files || [])]
      const inComposer = event.target === composer.current
      // Pasted files (screenshots, copied images) attach from anywhere, including the composer.
      if (files.length && (inComposer || canRedirect(event.target))) {
        event.preventDefault()
        attachFilesRef.current(files, [])
        return
      }
      if (!canRedirect(event.target)) return
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      insertTextRef.current(text, true)
    }
    // Files can be dropped anywhere in the window, not just on the composer.
    let depth = 0
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return
      event.preventDefault()
      depth++
      if (canAttach()) setDragging(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return
      // Always claim file drags so a missed drop never navigates the tab to the file.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = canAttach() ? 'copy' : 'none'
    }
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      if (!canAttach()) return
      attachFilesRef.current(
        [...(event.dataTransfer?.files || [])],
        droppedPaths(event.dataTransfer),
      )
    }
    const canAttach = () => {
      const element = composer.current
      return Boolean(element && !element.disabled && newThreadProject === null && !addProject)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [newThreadProject, addProject, activeId])
  // Inserts text at the cursor (or the end, when typing from elsewhere) in the composer.
  function insertText(text: string, atEnd = false) {
    const element = composer.current
    if (!element || !activeId) return
    element.focus()
    if (atEnd) element.setSelectionRange(element.value.length, element.value.length)
    // insertText keeps native undo and fires the input event React listens for.
    if (!document.execCommand('insertText', false, text)) {
      const next = element.value + text
      setDraft(next)
      drafts.current.set(activeId, next)
    }
  }
  const insertTextRef = useRef(insertText)
  insertTextRef.current = insertText
  // Images become attachments. Other files insert their path: the original path when the drag
  // carries one, otherwise the path of a saved copy (browsers hide Finder paths).
  async function handleFiles(files: File[], paths: string[]) {
    const threadId = activeId
    if (!threadId) return
    setError('')
    const images = files.filter(isAttachableImage)
    const others = files.filter((file) => !isAttachableImage(file))
    const added = images.map((file) => ({
      key: randomId(),
      name: file.name || 'image',
      previewUrl: URL.createObjectURL(file),
      status: 'uploading' as const,
    }))
    if (added.length)
      setPending((current) => ({
        ...current,
        [threadId]: [...(current[threadId] || []), ...added],
      }))
    const update = (key: string, change: Partial<PendingAttachment> | null) =>
      setPending((current) => ({
        ...current,
        [threadId]: (current[threadId] || []).flatMap((item) =>
          item.key !== key ? [item] : change ? [{ ...item, ...change }] : [],
        ),
      }))
    const uploads = images.map(async (file, index) => {
      const item = added[index]!
      try {
        const prepared = await prepareImage(file)
        if (!prepared) throw new Error(`${file.name} couldn't be read as an image.`)
        const uploaded = await uploadFile(prepared, 'image')
        if (uploaded.kind === 'image') update(item.key, { status: 'ready', id: uploaded.id })
      } catch (error) {
        URL.revokeObjectURL(item.previewUrl)
        update(item.key, null)
        setError((error as Error).message)
      }
    })
    const unmatched = [...paths]
    const inserted: string[] = []
    for (const file of others) {
      const match = unmatched.findIndex((path) => basename(path) === file.name)
      if (match >= 0) {
        inserted.push(unmatched.splice(match, 1)[0]!)
        continue
      }
      try {
        const uploaded = await uploadFile(file, 'file')
        if (uploaded.kind === 'file') inserted.push(uploaded.path)
      } catch (error) {
        setError((error as Error).message)
      }
    }
    // Paths without a file (e.g. folders dragged from an editor) are inserted as-is.
    if (!files.length) inserted.push(...unmatched)
    if (inserted.length && selectedId.current === threadId) {
      const element = composer.current
      const before = element?.value.slice(0, element.selectionStart ?? 0) ?? ''
      insertText(
        (before && !/\s$/.test(before) ? ' ' : '') + inserted.map(formatPath).join(' ') + ' ',
      )
    }
    await Promise.all(uploads)
  }
  // Every attach path goes through here, so a failure always shows instead of doing nothing.
  function attachFiles(files: File[], paths: string[]) {
    handleFiles(files, paths).catch((error: unknown) =>
      setError(error instanceof Error ? error.message : 'Could not attach these files.'),
    )
  }
  const attachFilesRef = useRef(attachFiles)
  attachFilesRef.current = attachFiles
  function removePending(key: string) {
    if (!activeId) return
    setPending((current) => ({
      ...current,
      [activeId]: (current[activeId] || []).filter((item) => {
        if (item.key === key) URL.revokeObjectURL(item.previewUrl)
        return item.key !== key
      }),
    }))
  }
  useLayoutEffect(() => {
    // The textarea may have just mounted (thread loaded): show this thread's draft in it.
    const element = composer.current
    if (element && element.value !== draftText.current) element.value = draftText.current
    resizeComposer()
  }, [activeId, thread?.id])
  // Opening a thread puts the cursor in the composer, once per thread, as soon as it renders.
  // Skipped on touch screens (it would pop up the keyboard) and while a dialog, menu, or
  // rename field has focus.
  const focusedThread = useRef<string | null>(null)
  const composerReady = Boolean(thread && thread.id === activeId)
  useEffect(() => {
    if (!activeId || !composerReady || focusedThread.current === activeId) return
    focusedThread.current = activeId
    if (window.matchMedia('(pointer: coarse)').matches) return
    const focused = document.activeElement
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      focused.closest('[role="dialog"], [role="menu"], .thread-rename')
    )
      return
    const element = composer.current
    if (!element) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [activeId, composerReady])

  function prepareSelection(id: string) {
    if (id === activeId) {
      setSidebarOpen(false)
      return
    }
    if (activeId) drafts.current.set(activeId, draftText.current)
    setThread(threadCache.current.get(id) ?? null)
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
      setThreads((current) => [{ ...created, lastMessageAt: created.createdAt }, ...current])
      select(created.id)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // ↑ in an empty composer brings back your previous messages (↓ goes forward, then back to an
  // empty composer), like a shell or Claude Code. The arrows only do this on the first / last
  // line and while the recalled text is untouched, so editing a draft is never hijacked. The
  // most recent message after a stopped or failed turn opens in edit mode.
  function recall(step: -1 | 1) {
    const element = composer.current
    if (!element || !thread || isActive(thread.status)) return false
    const caret = element.selectionStart ?? 0
    if (step < 0 && element.value.lastIndexOf('\n', caret - 1) !== -1) return false
    if (step > 0 && element.value.indexOf('\n', element.selectionEnd ?? caret) !== -1) return false
    const current = recalled.current?.thread === thread.id ? recalled.current : null
    const fresh = !element.value && !pending[thread.id]?.length
    if (current ? element.value !== current.text : !fresh || step > 0) return false
    const sent = thread.messages.filter(
      (message) => message.role === 'user' && (message.text || message.attachments?.length),
    )
    const index = (current?.index ?? sent.length) + step
    if (index < 0) return true
    const message = sent[index]
    recalled.current = message ? { thread: thread.id, index, text: message.text } : null
    setDraft(message?.text ?? '')
    // Images go back as already-uploaded attachments.
    setPending((list) => ({
      ...list,
      [thread.id]: (message?.attachments ?? []).map((item) => ({
        key: `recalled:${item.id}`,
        name: item.name,
        previewUrl: `/api/uploads/${encodeURIComponent(item.id)}`,
        status: 'ready' as const,
        id: item.id,
      })),
    }))
    setEditing(message && editableMessage(thread)?.id === message.id ? message.id : null)
    requestAnimationFrame(() =>
      element.setSelectionRange(element.value.length, element.value.length),
    )
    return true
  }
  function cancelEdit() {
    recalled.current = null
    setEditing(null)
    setDraft('')
    if (activeId) setPending((list) => ({ ...list, [activeId]: [] }))
    composer.current?.focus()
  }
  async function send(event?: FormEvent) {
    event?.preventDefault()
    const attached = activeId ? pending[activeId] || [] : []
    if (
      !activeId ||
      (!draftText.current.trim() && !attached.length) ||
      attached.some((item) => item.status !== 'ready') ||
      busy ||
      !connected ||
      !thread
    )
      return
    const text = draftText.current
    // Still the message that can be edited? (The thread may have moved on since.)
    const replacing = editing && editableMessage(thread)?.id === editing ? editing : null
    setBusy(true)
    setError('')
    stickToBottom.current = true
    try {
      await api(`threads/${activeId}/${replacing ? 'edit' : 'send'}`, 'POST', {
        ...(replacing ? { messageId: replacing } : {}),
        text,
        attachments: attached.map((item) => ({ id: item.id, name: item.name })),
      })
      recalled.current = null
      setEditing(null)
      if (selectedId.current === activeId) setDraft('')
      drafts.current.delete(activeId)
      for (const item of attached) URL.revokeObjectURL(item.previewUrl)
      setPending((current) => ({ ...current, [activeId]: [] }))
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
        threadCache.current.delete(target.id)
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
    if (!initial) return setAddProject(true)
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
  const copyPath = (path: string) => void copyText(path).catch(() => {})
  // Threads whose title is being rewritten (Regenerate title), shown with a spinner.
  const [retitling, setRetitling] = useState<ReadonlySet<string>>(() => new Set())
  // A fresh AI title from the conversation; the sidebar updates through the live connection.
  async function regenerateTitle(id: string) {
    setError('')
    setRetitling((current) => new Set(current).add(id))
    try {
      await api(`threads/${id}/title`, 'POST', {})
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setRetitling((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
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
  const committedProjectRename = useRef<typeof renamingProject>(null)
  async function renameProject() {
    // Same once-only guard as thread renames: Enter unmounts the input, which also fires blur.
    if (!renamingProject || committedProjectRename.current === renamingProject) return
    committedProjectRename.current = renamingProject
    const { path } = renamingProject
    const name = renamingProject.name.trim()
    setRenamingProject(null)
    const current = projects.find((project) => project.path === path)
    // Typing the folder name itself, or clearing the field, goes back to the folder name.
    const next = name === folderName(path) ? '' : name
    if (next === (current?.name ?? '')) return
    const show = (label: string) =>
      setProjects((list) =>
        list.map((project) =>
          project.path === path ? { ...project, name: label || undefined } : project,
        ),
      )
    show(next)
    try {
      await api('projects/rename', 'POST', { path, name: next })
    } catch (error) {
      show(current?.name ?? '')
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
    .filter(
      (group) =>
        !query ||
        group.items.length ||
        `${group.path} ${projectName(group.path)}`.toLowerCase().includes(query),
    )
  const active = thread ? isActive(thread.status) : false
  // Live dictation shows in the empty composer's placeholder. A placeholder doesn't count toward
  // the textarea's height, so the box is sized to the words as if they were typed; past the
  // maximum height it keeps the latest words (what you're saying now). Set on the element
  // directly, so live words never re-render the page.
  function showPreview(words: string) {
    const element = composer.current
    if (!element) return
    // With a draft in the box the placeholder isn't visible; just keep it current.
    if (!words || element.value) {
      element.placeholder = words || composerPlaceholder
      resizeComposer()
      return
    }
    const measure = (value: string) => {
      element.value = value
      element.style.height = 'auto'
      return element.scrollHeight
    }
    let text = words
    let height = measure(text)
    while (height > composerMaxHeight && text.length > 40) {
      // Drop the oldest ~15%, at a word boundary.
      const rest = text.slice(Math.ceil(text.length * 0.15)).replace(/^\S*\s+/, '')
      text = `… ${rest}`
      height = measure(text)
    }
    element.value = ''
    element.placeholder = text
    element.style.height = `${Math.min(height, composerMaxHeight)}px`
  }
  // The edit bar shows only while the recalled message is still the one that can be edited.
  const editingMessage = Boolean(thread && editing && editableMessage(thread)?.id === editing)
  const composerPlaceholder = !thread
    ? ''
    : active
      ? `${names[thread.provider]} is working… send a message to steer it`
      : `Chat with ${names[thread.provider]}`
  const folder = thread ? projectName(thread.cwd) : undefined
  const runningCount = threads.filter((item) => isActive(item.status)).length
  const missingClis = bootstrap
    ? (['claude', 'codex'] as const)
        .filter((provider) => !bootstrap.providers[provider].installed)
        .map((provider) => names[provider])
    : []
  // After an update, Settings → Agents shows the new version.
  const updatedProvider = (provider: Provider, version: string | null) =>
    setBootstrap((current) =>
      current && version
        ? {
            ...current,
            providers: { ...current.providers, [provider]: { installed: true, version } },
          }
        : current,
    )
  const diffOpen = Boolean(activeCwd && diffOpenIn[activeCwd])
  // Stable, so the (memoized) changes panel doesn't re-render on every keystroke.
  const toggleDiffRef = useRef(toggleDiff)
  toggleDiffRef.current = toggleDiff
  const closeDiff = useCallback(() => toggleDiffRef.current(false), [])
  // ⌘D toggles the changes panel when the open thread's project is a git repository.
  const toggleChangesRef = useRef(() => {})
  toggleChangesRef.current = () => {
    if (thread && git?.branch) toggleDiff(!diffOpen)
  }
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
                  <span className="step-label">{item.label}</span>
                  {item.summary ? (
                    <span className="step-summary" title={item.summary}>
                      {item.summary}
                    </span>
                  ) : null}
                </summary>
                {/* The full input (command, edit, arguments), then what it returned. */}
                {item.detail && item.detail !== item.summary ? (
                  <pre className="step-detail">{item.detail}</pre>
                ) : null}
                {item.output ? (
                  <>
                    <span className="step-section">Output</span>
                    <pre className="step-output">{item.output}</pre>
                  </>
                ) : null}
                {!item.output && (!item.detail || item.detail === item.summary) ? (
                  <p>{item.status === 'running' ? 'Running…' : 'No output.'}</p>
                ) : null}
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
              title={`New thread (${isMac ? '⇧⌘O' : 'Ctrl+Shift+O'})`}
            >
              <SquarePen size={15} />
            </button>
            <button
              className="icon-button"
              onClick={() => setAddProject(true)}
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
        {groups.length ? (
          <div className="sidebar-section">
            <span>Projects</span>
            {(() => {
              const anyExpanded = groups.some((group) => !collapsed[group.path])
              return (
                <button
                  className="icon-button"
                  aria-label={anyExpanded ? 'Collapse all projects' : 'Expand all projects'}
                  title={anyExpanded ? 'Collapse all' : 'Expand all'}
                  onClick={() =>
                    setCollapsed(
                      anyExpanded
                        ? Object.fromEntries(projectPaths.map((path) => [path, true]))
                        : {},
                    )
                  }
                >
                  {anyExpanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
                </button>
              )
            })()}
          </div>
        ) : null}
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
                {renamingProject?.path === cwd ? (
                  <div className="project-toggle renaming">
                    {collapsed[cwd] ? <Folder size={14} /> : <FolderOpen size={14} />}
                    <input
                      className="thread-rename"
                      aria-label="Project name"
                      autoFocus
                      maxLength={80}
                      placeholder={folderName(cwd)}
                      title="Leave empty to use the folder name"
                      value={renamingProject.name}
                      onFocus={(event) => event.target.select()}
                      onChange={(event) =>
                        setRenamingProject({ path: cwd, name: event.target.value })
                      }
                      onBlur={() => void renameProject()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void renameProject()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          setRenamingProject(null)
                        }
                      }}
                    />
                  </div>
                ) : (
                  <button
                    className="project-toggle"
                    // The second click of a double-click renames instead of toggling again.
                    onClick={(event) => {
                      if (event.detail < 2) setCollapsed({ ...collapsed, [cwd]: !collapsed[cwd] })
                    }}
                    onDoubleClick={() => {
                      // Undo the first click's toggle, then rename.
                      setCollapsed((current) => ({ ...current, [cwd]: !current[cwd] }))
                      setRenamingProject({ path: cwd, name: projectName(cwd) })
                    }}
                    aria-expanded={!collapsed[cwd]}
                    title={cwd}
                  >
                    {collapsed[cwd] ? <Folder size={14} /> : <FolderOpen size={14} />}
                    <span>{projectName(cwd)}</span>
                  </button>
                )}
                <button
                  className="icon-button project-add"
                  aria-label={`New thread in ${projectName(cwd)}`}
                  title={`New thread in ${projectName(cwd)}`}
                  disabled={busy}
                  onClick={() => void quickCreate(cwd)}
                >
                  <Plus size={15} />
                </button>
              </div>
              {!collapsed[cwd] || query
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
                      // The ⋮ button sits beside the link (a button can't live inside a link).
                      <div className="thread-row-wrap" key={item.id}>
                        <Link
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
                          {/* While a new title is being written, a spinner stands in for the dot. */}
                          {retitling.has(item.id) ? (
                            <LoaderCircle
                              size={12}
                              className="status-spinner thread-retitling"
                              aria-label="Writing a new title"
                            />
                          ) : (
                            <StatusDot status={item.status} unread={unread.has(item.id)} />
                          )}
                          <span className="thread-title">{item.title}</span>
                          <span className="thread-time">
                            {item.status === 'waiting'
                              ? 'Approval'
                              : relativeTime(item.updatedAt, now)}
                          </span>
                        </Link>
                        <button
                          type="button"
                          className="thread-more"
                          aria-label={`More actions for ${item.title}`}
                          title="More"
                          aria-haspopup="menu"
                          aria-expanded={menu?.kind === 'thread' && menu.id === item.id}
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            setMenu({
                              kind: 'thread',
                              id: item.id,
                              position: { x: rect.left, y: rect.bottom + 4 },
                            })
                          }}
                        >
                          <EllipsisVertical size={14} />
                        </button>
                      </div>
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
        <ProviderUpdates
          enabled={Boolean(bootstrap && !bootstrap.remote)}
          onUpdated={updatedProvider}
        />
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
          {/* A reminder on the Mac while phones can connect. */}
          {bootstrap?.phoneAccess && !bootstrap.remote ? (
            <button
              className="icon-button phone-on"
              aria-label="Phone access is on. Open settings"
              title="Phone access is on"
              onClick={() => setSettingsOpen(true)}
            >
              <Smartphone size={14} />
            </button>
          ) : null}
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
        <div className="main-column">
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
              {thread && retitling.has(thread.id) ? (
                <LoaderCircle
                  size={13}
                  className="status-spinner"
                  aria-label="Writing a new title"
                />
              ) : null}
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
                  {bootstrap?.editors?.vscode && !bootstrap.remote ? (
                    <button
                      className="icon-button"
                      aria-label="Open project in VS Code"
                      title={`Open ${folder} in VS Code`}
                      onClick={() =>
                        void api(`threads/${thread.id}/open-editor`, 'POST', {}).catch(
                          (error: Error) => setError(error.message),
                        )
                      }
                    >
                      <VSCodeIcon size={15} />
                    </button>
                  ) : null}
                  {git?.branch ? (
                    <button
                      className={`icon-button ${diffOpen ? 'active' : ''}`}
                      aria-label={diffOpen ? 'Hide changes' : 'Show changes'}
                      aria-pressed={diffOpen}
                      title={`${diffOpen ? 'Hide' : 'Show'} changes (${isMac ? '⌘D' : 'Ctrl+D'})`}
                      onClick={() => toggleDiff(!diffOpen)}
                    >
                      <FileDiff size={15} />
                    </button>
                  ) : null}
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
          <div className="chat-column">
            <div
              className="chat-scroll"
              ref={scrollArea}
              onScroll={() => {
                const element = scrollArea.current
                // Scroll positions while a thread is still settling aren't the user's choice.
                if (element && Date.now() >= settleUntil.current)
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
                            <kbd>{isMac ? '⇧⌘O' : 'Ctrl+Shift+O'}</kbd>
                          </button>
                          <button
                            className="secondary"
                            disabled={!bootstrap}
                            onClick={() => setAddProject(true)}
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
                        <MessageView message={message} />
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
                            onClick={() =>
                              action('approve', { approvalId: approval.id, allow: false })
                            }
                          >
                            Decline
                          </button>
                          <button
                            className="primary"
                            disabled={busy || !connected}
                            onClick={() =>
                              action('approve', { approvalId: approval.id, allow: true })
                            }
                          >
                            Allow once
                          </button>
                        </div>
                      </section>
                    ))}
                    {/* One working indicator: the work log shows it once the agent starts using tools. */}
                    {active && !thread.approvals.length && !thread.activities.length ? (
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
                    {editingMessage ? (
                      <div className="composer-editing">
                        <Pencil size={12} />
                        <span>
                          Editing your last message · it replaces the stopped turn{' '}
                          <small>(files it changed stay changed)</small>
                        </span>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Cancel editing"
                          title="Cancel (Esc)"
                          onClick={cancelEdit}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : null}
                    {pending[thread.id]?.length ? (
                      <div className="pending-attachments">
                        {pending[thread.id]!.map((item) => (
                          <div
                            className={`pending-image ${item.status}`}
                            key={item.key}
                            title={item.name}
                          >
                            <img src={item.previewUrl} alt={item.name} />
                            {item.status === 'uploading' ? (
                              <LoaderCircle size={14} className="status-spinner" />
                            ) : null}
                            <button
                              type="button"
                              className="pending-remove"
                              aria-label={`Remove ${item.name}`}
                              onClick={() => removePending(item.key)}
                            >
                              <X size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <textarea
                      ref={composer}
                      aria-label="Message your agent"
                      placeholder={composerPlaceholder}
                      defaultValue={draftText.current}
                      onChange={(e) => draftChanged(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          void send()
                        } else if (
                          (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                          !e.shiftKey &&
                          !e.altKey &&
                          !e.metaKey &&
                          !e.ctrlKey &&
                          !e.nativeEvent.isComposing &&
                          recall(e.key === 'ArrowUp' ? -1 : 1)
                        )
                          e.preventDefault()
                        else if (e.key === 'Escape' && editingMessage) {
                          e.preventDefault()
                          cancelEdit()
                        }
                      }}
                      rows={1}
                    />
                    <div className="composer-toolbar">
                      <div className="composer-left">
                        {/* The file input covers the button so a tap opens the picker natively;
                            iOS Safari won't open a hidden input from a script click. */}
                        <label
                          className={`round-button attach-button ${busy ? 'disabled' : ''}`}
                          title="Attach images or files (or paste / drop them)"
                        >
                          <Plus size={15} />
                          <input
                            ref={filePicker}
                            type="file"
                            multiple
                            aria-label="Attach images or files"
                            disabled={busy}
                            onChange={(event) => {
                              const files = [...(event.target.files || [])]
                              event.target.value = ''
                              if (files.length) attachFiles(files, [])
                            }}
                          />
                        </label>
                        <AgentSettingsControls
                          key={thread.id}
                          provider={thread.provider}
                          cwd={thread.cwd}
                          value={{
                            model: thread.model,
                            effort: thread.effort || '',
                            serviceTier: thread.serviceTier || '',
                            permissionMode: thread.permissionMode || defaultPermission,
                          }}
                          onChange={(settings) => void updateSettings(settings)}
                          disabled={active || !connected}
                          busy={busy}
                          agent={
                            bootstrap
                              ? {
                                  installed: {
                                    claude: bootstrap.providers.claude.installed,
                                    codex: bootstrap.providers.codex.installed,
                                  },
                                  locked: thread.messages.length > 0 || Boolean(thread.sessionId),
                                  // Switching agents brings back that agent's last-used settings,
                                  // or the model picked from its tab (with default effort).
                                  onChange: (provider, model) => {
                                    if (provider === thread.provider) return
                                    const remembered = settingsFor(provider)
                                    void updateSettings(
                                      model === undefined
                                        ? remembered
                                        : { ...remembered, model, effort: '', serviceTier: '' },
                                      provider,
                                    )
                                  },
                                }
                              : undefined
                          }
                        />
                      </div>
                      <div className="composer-actions">
                        {bootstrap?.dictation && dictationSupported() ? (
                          <DictationButton
                            threadId={thread.id}
                            onText={(text) => {
                              const element = composer.current
                              const before =
                                element?.value.slice(0, element.selectionStart ?? 0) ?? ''
                              insertText((before && !/\s$/.test(before) ? ' ' : '') + text)
                            }}
                            // Live words go straight onto the placeholder (no re-render per word).
                            onPreview={showPreview}
                            onError={setError}
                          />
                        ) : null}
                        {active ? (
                          <button
                            className="stop-button"
                            type="button"
                            aria-label="Stop"
                            title="Stop"
                            onClick={() => action('stop')}
                            disabled={!connected}
                          >
                            <Square size={10} fill="currentColor" />
                          </button>
                        ) : null}
                        {/* While the agent works, Send steers it (shown once there's something to send). */}
                        {!active || hasDraft || pending[thread.id]?.length ? (
                          <button
                            className="send-button"
                            type="submit"
                            aria-label="Send message"
                            title="Send (Enter)"
                            disabled={
                              (!hasDraft && !pending[thread.id]?.length) ||
                              Boolean(
                                pending[thread.id]?.some((item) => item.status !== 'ready'),
                              ) ||
                              busy ||
                              !connected
                            }
                          >
                            <ArrowUp size={15} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </form>
                ) : null}
                {thread &&
                (git?.branch || processes.some((item) => item.project === thread.cwd)) ? (
                  <div className="composer-meta">
                    {git?.branch ? (
                      // Opens the branch on GitHub in a new tab when the remote is there.
                      <a
                        className="git-branch"
                        href={git.url}
                        target={git.url ? '_blank' : undefined}
                        rel={git.url ? 'noopener noreferrer' : undefined}
                        title={
                          (git.detached
                            ? `Detached HEAD at ${git.branch}`
                            : `Branch ${git.branch}`) + (git.url ? ' — open on GitHub' : '')
                        }
                      >
                        <GitBranch size={12} />
                        <span>{git.detached ? `detached at ${git.branch}` : git.branch}</span>
                        {git.url ? (
                          <ExternalLink size={11} className="git-branch-external" />
                        ) : null}
                      </a>
                    ) : null}
                    {/* Dev servers and other processes agents started in this project. */}
                    <ProcessIndicator processes={processes} project={thread.cwd} />
                  </div>
                ) : null}
              </footer>
            ) : null}
          </div>
        </div>
        {/* Full height beside the header and chat, like an editor's side panel. */}
        {thread && diffOpen && git?.branch ? (
          <DiffPanel
            threadId={thread.id}
            project={thread.cwd}
            refreshKey={`${thread.status}:${thread.activities.filter((item) => item.status !== 'running').length}`}
            onClose={closeDiff}
          />
        ) : null}
      </main>
      <ImagePreview />
      {dragging ? (
        <div className="drop-overlay" aria-hidden>
          <div>
            <FileUp size={22} />
            <strong>Drop to attach</strong>
            <span>Images attach to your message · other files add their path</span>
          </div>
        </div>
      ) : null}
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
          projectName={projectName}
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
                  label: retitling.has(target.id) ? 'Writing a title…' : 'Regenerate title',
                  icon: <Sparkles size={14} />,
                  disabled: retitling.has(target.id),
                  onSelect: () => void regenerateTitle(target.id),
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
                {
                  label: 'Rename',
                  icon: <Pencil size={14} />,
                  onSelect: () => setRenamingProject({ path, name: projectName(path) }),
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
          remote={Boolean(bootstrap?.remote)}
          onDictationChange={(dictation) =>
            setBootstrap((current) => (current ? { ...current, dictation } : current))
          }
          onPhoneAccessChange={(phoneAccess) =>
            setBootstrap((current) => (current ? { ...current, phoneAccess } : current))
          }
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
          projectName={projectName}
          initialProject={newThreadProject}
          onAddProject={() => {
            setNewThreadProject(null)
            setAddProject(true)
          }}
          onClose={() => setNewThreadProject(null)}
          onCreated={(created) => {
            setNewThreadProject(null)
            setThreads((current) => [{ ...created, lastMessageAt: created.createdAt }, ...current])
            select(created.id)
          }}
        />
      ) : null}
      {addProject && bootstrap ? (
        <AddProject
          canBrowse={!bootstrap.remote}
          initialPath={loadPreferences().cwd || bootstrap.defaultCwd}
          onClose={() => setAddProject(false)}
          onAdded={(project) => {
            setProjects((current) => [
              project,
              ...current.filter((item) => item.path !== project.path),
            ])
            setCollapsed((current) => ({ ...current, [project.path]: false }))
            setAddProject(false)
            // Start working in it right away: a new thread with your last agent and settings.
            void quickCreate(project.path)
          }}
        />
      ) : null}
    </div>
  )
}
function NewThread({
  bootstrap,
  projects,
  projectName,
  initialProject,
  onAddProject,
  onClose,
  onCreated,
}: {
  bootstrap: Bootstrap
  projects: string[]
  projectName: (path: string) => string
  initialProject: string
  onAddProject: () => void
  onClose: () => void
  onCreated: (thread: Thread) => void
}) {
  const [cwd, setCwd] = useState(initialProject)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
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
    label: projectName(path),
    description: path,
  }))
  return (
    <Modal
      className="new-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form onSubmit={create}>
        <div className="dialog-top">
          <ModalTitle render={<h2 />}>New thread</ModalTitle>
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
            text={projectName(cwd)}
            value={cwd}
            options={options}
            disabled={busy}
            placement="down"
            onSelect={setCwd}
            action={{
              label: 'Add project…',
              icon: <FolderPlus size={14} />,
              onSelect: onAddProject,
            }}
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
    </Modal>
  )
}
function AddProject({
  canBrowse,
  initialPath,
  onClose,
  onAdded,
}: {
  // The folder chooser opens on the Mac, so a paired phone types the path instead.
  canBrowse: boolean
  initialPath: string
  onClose: () => void
  onAdded: (project: ProjectSummary) => void
}) {
  const [path, setPath] = useState(initialPath)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
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
    <Modal
      className="new-dialog"
      onClose={() => {
        if (!busy && !picking) onClose()
      }}
    >
      <form onSubmit={add}>
        <div className="dialog-top">
          <ModalTitle render={<h2 />}>Add project</ModalTitle>
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
            {canBrowse ? (
              <button
                className="secondary"
                type="button"
                onClick={browse}
                disabled={busy || picking}
              >
                <FolderOpen size={14} />
                {picking ? 'Choosing…' : 'Browse'}
              </button>
            ) : null}
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
    </Modal>
  )
}
