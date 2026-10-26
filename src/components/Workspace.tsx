import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
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
  FolderGit2,
  Workflow,
  Bot,
  FileUp,
  FileDiff,
  FileText,
  GitBranch,
  GitPullRequest,
  FolderOpen,
  Link2,
  LoaderCircle,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Monitor,
  RotateCcw,
  Moon,
  Pencil,
  Plus,
  Search,
  Server,
  Settings,
  Settings2,
  MonitorSmartphone,
  Sparkles,
  SquareCheck,
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
import {
  AgentSettingsControls,
  Picker,
  ProviderMark,
  providerNames,
  SettingsMenu,
} from './AgentSettingsControls'
import { VSCodeIcon } from './ProviderIcon'
import { defaultPermission, type AgentSettings } from '../agent-settings'
import { loadPreferences, rememberChoice, settingsFor } from '../preferences'
import {
  desktopPermission,
  eventLabel,
  forgetTab,
  isNotifyingTab,
  loadNotificationPreferences,
  markTabAlive,
  setServerTab,
  setTabView,
  markTabVisited,
  tabHeartbeatMs,
  requestDesktopPermission,
  saveNotificationPreferences,
  threadEvents,
  type NotificationPreferences,
  type ThreadEvent,
} from '../notifications'
import { NotificationPrompt, SettingsDialog, Toasts } from './Notifications'
import { ProviderUpdates } from './ProviderUpdates'
import { AppUpdate, type Update as AppUpdateState } from './AppUpdate'
import { DiffPanel } from './DiffPanel'
import { Blocks } from './blocks'
import type { Block, DelegationBlock } from '../blocks'
import { ProcessIndicator } from './Processes'
import { BrowserChip } from './BrowserChip'
import { SubAgentChip } from './DelegationCard'
import { BackgroundMusic } from './BackgroundMusic'
import { ProjectAvatar, useProjectIcons } from './ProjectAvatar'
import { applyShared, registerShared, shareSetting } from '../shared-settings'
import type { ProcessInfo } from '../server/processes'
import { ImagePreview, previewOnClick, setPreviewGallery, threadImages } from './ImagePreview'
import { DictationButton, dictationSupported } from './Dictation'
import { Modal, ModalTitle } from './Modal'
import { useConfirm } from './ConfirmDialog'
import { QuestionCard } from './QuestionCard'
import { CommandPalette } from './CommandPalette'
import { ProjectSettings } from './ProjectSettings'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { SidebarResize } from './SidebarResize'
import { ProjectFilter } from './ProjectFilter'
import { CopyButton } from './CopyButton'
import { Diagram } from './Diagram'
import { imageLoading } from '../loaded-images'
import { ScrollToBottom } from './ScrollToBottom'
import { localDevUrl, openPreview } from '../open-preview'
import { dateSections } from '../sidebar-groups'
import {
  Celebration,
  CompactMarker,
  LiveLine,
  StepGroup,
  StepRow,
  TodoCard,
  stepTitle,
} from './WorkSteps'
import { linkify } from '../linkify'
import { Segmented } from './ui'
import {
  ApiBase,
  apiBaseFor,
  useApiBase,
  hubProject,
  hubSummary,
  hubThread,
  isRemote,
  machinePath,
  parseRemote,
  threadApi,
  type HubMachine,
} from '../hub'
import type { MachineSummary } from '../server/machines'
// A machine's part of the sidebar (the hub, src/hub.ts).
type HubState = { threads: ThreadSummary[]; projects: ProjectSummary[] }
import {
  buildTurns,
  finishLabel,
  foldLabel,
  liveNote,
  unfinished,
  type WorkItem,
} from '../timeline'
import { reuseItems, reuseThread } from '../reuse'
import { RecentMap } from '../recent-map'
import { quote, SelectionActions } from './SelectionActions'
import { applyThreadPatch, type ThreadPatch } from '../thread-patch'
import { ThreadPreviewCard, ThreadPreviewTrigger, threadPreview } from './ThreadPreview'
import { ContextMenu, menuPosition, type MenuItem, type MenuPosition } from './ContextMenu'
import { playSound, unlockSound } from '../sound'
import {
  basename,
  droppedPaths,
  formatPath,
  formatSize,
  hasFiles,
  copyText,
  isAttachableImage,
  longPaste,
  prepareImage,
  randomId,
  uploadFile,
  withAttachedFiles,
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
  onThemeChange,
} from '../theme'
import remarkGfm from 'remark-gfm'
import {
  editableMessage,
  isActive,
  type Activity,
  type Bootstrap,
  type BrowserInfo,
  type UiSettings,
  type GitInfo,
  type PullRequest,
  type HelperReport,
  type Message,
  type MessageMatch,
  type ProjectSummary,
  type Provider,
  type Status,
  type Thread,
  type GroupBy,
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
// A code block in a reply, with a button that copies its text.
function CodeBlock({ children, ...props }: React.ComponentProps<'pre'>) {
  const block = useRef<HTMLPreElement>(null)
  return (
    <div className="code-block">
      <pre ref={block} {...props}>
        {children}
      </pre>
      <CopyButton
        className="code-copy"
        label="Copy code"
        text={() => (block.current?.textContent ?? '').replace(/\n$/, '')}
      />
    </div>
  )
}
// The text of a ```mermaid code block (react-markdown's <pre><code class="language-mermaid">).
type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}
function mermaidSource(node: HastNode | undefined) {
  const code = node?.children?.find((child) => child.tagName === 'code')
  const classes = code?.properties?.className
  if (!Array.isArray(classes) || !classes.includes('language-mermaid')) return undefined
  const text = (code?.children ?? [])
    .map((child) => child.value ?? '')
    .join('')
    .trim()
  return text || undefined
}
// Links in agent replies open in a new tab so the conversation stays put. noopener/noreferrer
// stops the opened page from controlling this tab or seeing its URL. react-markdown's default
// URL filter still drops unsafe schemes such as javascript:.
const markdownComponents: Components = {
  // ```mermaid blocks draw as diagrams; while one is still streaming (or isn't valid) it
  // stays a plain code block.
  pre: ({ node, ...props }) => {
    const source = mermaidSource(node)
    const code = <CodeBlock {...props} />
    return source ? <Diagram source={source} fallback={code} /> : code
  },
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
// Parsed replies are also kept across thread switches (memo alone forgets them when a thread
// closes), so reopening a long thread doesn't parse hundreds of replies again. Markdown is a
// plain function of the text (no hooks; our components render later as usual), so its output
// can be reused. Least recently used first out, capped by count and total text.
const parsedMarkdown = new Map<string, ReactNode>()
let parsedChars = 0
let lastParsed: string | undefined
const maxParsed = 3000
const maxParsedChars = 4_000_000
function parseMarkdown(text: string) {
  const cached = parsedMarkdown.get(text)
  if (cached !== undefined) {
    parsedMarkdown.delete(text)
    parsedMarkdown.set(text, cached)
    return cached
  }
  const parsed = Markdown({
    children: text,
    remarkPlugins: markdownPlugins,
    components: markdownComponents,
  })
  // A streaming reply grows by appends: drop the version it grew from, or every partial reply
  // (hundreds per answer) would fill the cache and push out finished ones.
  if (lastParsed && text.startsWith(lastParsed) && parsedMarkdown.delete(lastParsed))
    parsedChars -= lastParsed.length
  lastParsed = text
  parsedMarkdown.set(text, parsed)
  parsedChars += text.length
  for (const [oldest] of parsedMarkdown) {
    if (parsedMarkdown.size <= maxParsed && parsedChars <= maxParsedChars) break
    parsedMarkdown.delete(oldest)
    parsedChars -= oldest.length
  }
  return parsed
}
const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return parseMarkdown(text)
})
// One message. Live updates parse a fresh copy of the thread every time, so rows compare by
// content rather than identity; unchanged messages skip rendering entirely.
// Your message with its web links clickable (new tab, like links in agent replies).
function LinkedText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, index) =>
        part.href ? (
          <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  )
}
// A helper's report in its lead thread (orchestration): who, how it went, its branch, and its
// answer. The full text (with the header the agent reads) stays in the message for copying.
const reportLabels: Record<HelperReport['status'], string> = {
  completed: 'Finished',
  failed: 'Failed',
  waiting: 'Waiting for you',
}
function ReportCard({ message, report }: { message: Message; report: HelperReport }) {
  return (
    <div className={`report-card ${report.status}`}>
      <div className="report-head">
        {report.delegate ? <Bot size={13} aria-hidden /> : <Workflow size={13} aria-hidden />}
        <Link to="/threads/$threadId" params={{ threadId: report.threadId }}>
          {report.title}
        </Link>
        <span className="report-status">
          {report.delegate ? 'Sub-agent · ' : ''}
          {reportLabels[report.status]}
        </span>
        {report.branch ? (
          <span className="report-branch">
            <GitBranch size={11} aria-hidden />
            {report.branch}
          </span>
        ) : null}
      </div>
      <div className="markdown report-answer">
        <MessageMarkdown text={report.answer} />
      </div>
      {message.unsent ? (
        <span className="message-note">
          Not sent to the agent · it reacted to 10 reports in a row; write to continue
        </span>
      ) : message.queued ? (
        <span className="message-note">Queued · goes to the agent when its turn ends</span>
      ) : null}
    </div>
  )
}
// What a sidebar row does when clicked, right-clicked, double-clicked, or its ⋮ opened.
type RowActions = {
  click: (event: React.MouseEvent<HTMLAnchorElement>, id: string) => void
  contextMenu: (event: React.MouseEvent<HTMLAnchorElement>, id: string) => void
  rename: (id: string, title: string) => void
  more: (event: React.MouseEvent<HTMLButtonElement>, id: string) => void
}
// One thread in the sidebar. Memoized with plain props (live updates keep unchanged threads'
// objects, see reuse.ts), so a live update or a keystroke only re-renders the rows that changed
// instead of every row and its avatar, hover card, and menu button.
const ThreadRow = memo(function ThreadRow({
  item,
  actions,
  showProject,
  projectName,
  icons,
  project,
  selected,
  unread,
  picked,
  picking,
  busy,
  retitling,
  time,
  menuOpen,
  snippet,
}: {
  item: ThreadSummary
  actions: React.RefObject<RowActions>
  // Not grouped: the project's name (and avatar) above the title.
  showProject: boolean
  projectName: string
  // Project icons on (Settings): the project's avatar, else a folder.
  icons: boolean
  project: ProjectSummary | undefined
  selected: boolean
  unread: boolean
  picked: boolean
  picking: boolean
  busy: boolean
  retitling: boolean
  // The time or status word ("Done", "Question"…) shown when it isn't working.
  time: string
  menuOpen: boolean
  // Searching: where the query was found in the conversation (when the title doesn't have it).
  snippet?: string
}) {
  // The time doubles as the status: the working dots while the agent works, a spinner while a
  // new title is being written, Question or Approval while it waits for you, Done (green) or
  // Failed (red) when a turn ended and you haven't opened it yet, and a red time after a
  // failure.
  const status =
    item.status === 'starting' || item.status === 'working' ? (
      <span className="thread-time working">
        <StatusDot status={item.status} />
      </span>
    ) : retitling ? (
      <span className="thread-time working">
        <LoaderCircle size={12} className="status-spinner" aria-label="Writing a new title" />
      </span>
    ) : (
      <span
        className={`thread-time ${item.status} ${unread ? 'unread' : ''}`}
        title={item.status === 'failed' ? labels.failed : undefined}
      >
        {time}
      </span>
    )
  return (
    // The ⋮ button sits beside the link (a button can't live inside a link).
    <div className="thread-row-wrap">
      {/* Resting on a row for a moment shows its hover card (ThreadPreview). */}
      <ThreadPreviewTrigger
        handle={threadPreview}
        payload={item.id}
        delay={700}
        closeDelay={150}
        render={
          <Link
            to="/threads/$threadId"
            params={{ threadId: item.id }}
            data-thread-id={item.id}
            className={`thread-row ${selected ? 'selected' : ''} ${unread ? 'unread' : ''} ${picked ? 'picked' : ''}`}
            aria-selected={picking ? picked : undefined}
            onClick={(event) => actions.current.click(event, item.id)}
            onContextMenu={(event) => actions.current.contextMenu(event, item.id)}
            onDoubleClick={(event) => {
              event.preventDefault()
              actions.current.rename(item.id, item.title)
            }}
            aria-disabled={busy}
            aria-current={selected ? 'page' : undefined}
          />
        }
      >
        {/* A picked thread shows a check before its title. */}
        {picked ? (
          <span className="thread-pick" aria-hidden>
            <Check size={9} strokeWidth={3.5} />
          </span>
        ) : null}
        {showProject ? (
          // Not grouped: the project, and the thread's title under it.
          <span className="thread-lines">
            <span className="thread-project">
              {icons ? (
                <ProjectAvatar path={item.cwd} name={projectName} project={project} />
              ) : (
                <Folder size={14} />
              )}
              <span>{projectName}</span>
              {item.machine ? <MachineTag name={item.machine} /> : null}
            </span>
            <span className="thread-title">{item.title}</span>
            {snippet ? <span className="thread-snippet">{snippet}</span> : null}
          </span>
        ) : snippet ? (
          <span className="thread-lines">
            <span className="thread-title">{item.title}</span>
            <span className="thread-snippet">{snippet}</span>
          </span>
        ) : (
          <span className="thread-title">{item.title}</span>
        )}
        {status}
      </ThreadPreviewTrigger>
      <button
        type="button"
        className="thread-more"
        aria-label={`More actions for ${item.title}`}
        title="More"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => actions.current.more(event, item.id)}
      >
        <EllipsisVertical size={14} />
      </button>
    </div>
  )
})

// Shared empty block list: a new [] on each render would defeat MessageView's memo.
const noBlocks: Block[] = []
// What the Retry and Edit buttons under your last message do. Workspace passes a ref that never
// changes, so MessageView's memo isn't defeated by new callbacks on every live update.
type MessageActions = { retry: (message: Message) => void; edit: (message: Message) => void }
// The same blocks, one by one. Live updates keep unchanged blocks as the same objects (reuse.ts),
// so a card that changed after its turn ended (a sub-agent finishing) still re-renders.
function sameBlocks(before: Block[] | undefined, after: Block[] | undefined) {
  if (before === after) return true
  if ((before?.length ?? 0) !== (after?.length ?? 0)) return false
  return (before ?? []).every((block, index) => block === after![index])
}
const MessageView = memo(
  // meta: the time and copy row under the message (left off the agent's in-between notes).
  // blocks: tool content to show instead of the message's own (a finished turn gathers its
  // images and diagrams onto the final answer, and its folded notes show none).
  // leading: tool content shown above the text: what the agent showed while working, before it
  // wrote this answer (so "the diagrams above" reads right).
  // editable: your last message once its turn has ended: it gets Retry and Edit buttons, which
  // call `actions` (a stable ref).
  function MessageView({
    message,
    meta = true,
    blocks = message.blocks,
    leading,
    editable = false,
    actions,
  }: {
    message: Message
    meta?: boolean
    blocks?: Block[]
    leading?: Block[]
    editable?: boolean
    actions?: { current: MessageActions | null }
  }) {
    // Where this thread's uploads live: here, or on its machine (the hub).
    const base = useApiBase()
    // A helper thread's report to this (lead) thread: a card with a link to the helper.
    if (message.report)
      return (
        <article className="message report" data-message={message.id}>
          <ReportCard message={message} report={message.report} />
        </article>
      )
    return (
      <article className={`message ${message.role}`} data-message={message.id}>
        {message.role === 'user' ? (
          <>
            {message.attachments?.length ? (
              <div className="message-images">
                {message.attachments.map((item) => (
                  <a
                    key={item.id}
                    href={`${base}/uploads/${encodeURIComponent(item.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={item.name}
                    onClick={previewOnClick({
                      src: `${base}/uploads/${encodeURIComponent(item.id)}`,
                      alt: item.name,
                      caption: item.name,
                    })}
                  >
                    <img
                      src={`${base}/uploads/${encodeURIComponent(item.id)}`}
                      alt={item.name}
                      {...imageLoading(`${base}/uploads/${encodeURIComponent(item.id)}`)}
                      decoding="async"
                    />
                  </a>
                ))}
              </div>
            ) : null}
            {message.text ? (
              <div className="user-bubble">
                <LinkedText text={message.text} />
              </div>
            ) : null}
            {message.queued ? (
              <span className="message-note">Queued · sends when the current turn ends</span>
            ) : message.unsent ? (
              <span className="message-note">Not sent · the turn was stopped</span>
            ) : message.rewindFailed ? (
              <span className="message-note">
                Sent as a follow-up · the agent couldn’t drop the earlier attempt
              </span>
            ) : message.answered ? (
              <span className="message-note">Answered the question</span>
            ) : null}
          </>
        ) : (
          <>
            {leading?.length ? <Blocks blocks={leading} /> : null}
            {message.text ? (
              <div className="markdown">
                <MessageMarkdown text={message.text} />
              </div>
            ) : null}
            {/* Images and other content added by tools during this reply. */}
            {blocks?.length ? <Blocks blocks={blocks} /> : null}
          </>
        )}
        {/* Shown on hover (always on touch screens), like Claude Desktop: the time, Retry and
            Edit on your last message, and a copy button for the message as written (a reply's
            Markdown source). */}
        {meta ? (
          <div className="message-actions">
            <time dateTime={message.createdAt}>
              {new Date(message.createdAt).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </time>
            {editable && message.role === 'user' ? (
              <>
                <button
                  type="button"
                  className="icon-button message-action"
                  aria-label="Retry"
                  title="Retry · run this message again"
                  onClick={() => actions?.current?.retry(message)}
                >
                  <RotateCcw size={13} />
                </button>
                <button
                  type="button"
                  className="icon-button message-action"
                  aria-label="Edit message"
                  title="Edit"
                  onClick={() => actions?.current?.edit(message)}
                >
                  <Pencil size={13} />
                </button>
              </>
            ) : null}
            {message.text ? (
              <CopyButton
                className="message-copy"
                label={message.role === 'user' ? 'Copy message' : 'Copy reply'}
                text={() => message.text}
              />
            ) : null}
          </div>
        ) : null}
      </article>
    )
  },
  (before, after) =>
    before.meta === after.meta &&
    before.editable === after.editable &&
    before.message.id === after.message.id &&
    before.message.text === after.message.text &&
    before.message.queued === after.message.queued &&
    before.message.unsent === after.message.unsent &&
    before.message.createdAt === after.message.createdAt &&
    (before.message.attachments?.length ?? 0) === (after.message.attachments?.length ?? 0) &&
    sameBlocks(before.blocks ?? before.message.blocks, after.blocks ?? after.message.blocks) &&
    sameBlocks(before.leading, after.leading),
)
// What deleting threads reports: worktrees kept because they had uncommitted changes.
type DeleteResult = { keptWorktrees?: string[] }
// "1 thread", "3 threads".
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
// The composer grows with its text (or a live dictation preview) up to this height, then scrolls.
const composerMaxHeight = 240
// Where Group by was saved per browser before it moved to the server (read once, then removed).
const groupByKey = 't3-mini:sidebar-group'
// Only the sections you folded or opened yourself; v2 dropped the old defaults (Older folded).
const projectFilterKey = 't3-mini:project-filter'
// A sidebar search excerpt, started a few words before the match so the match shows in the
// narrow sidebar (the server's excerpt starts further back, for the wider ⌘K palette).
function nearMatch(snippet: string, query: string) {
  const at = snippet.toLowerCase().indexOf(query)
  if (at <= 24) return snippet
  const space = snippet.indexOf(' ', at - 20)
  const start = space >= 0 && space < at ? space + 1 : at
  return `…${snippet.slice(start)}`
}
const dateFoldedKey = 't3-mini:date-sections-folded-v2'
// The folder's name (a machine's folder too: its hub id carries the machine, see src/hub.ts).
const folderName = (cwd: string) => machinePath(cwd).split('/').filter(Boolean).at(-1) || '/'
// The machine a project or thread lives on (the hub), next to its name.
function MachineTag({ name }: { name: string }) {
  return (
    <span className="machine-tag" title={`On ${name}`}>
      <Server size={10} aria-hidden />
      {name}
    </span>
  )
}
// A project's name: the one you gave it in the sidebar, else its folder name.
const projectLabel = (projects: ProjectSummary[], path: string) =>
  projects.find((project) => project.path === path)?.name || folderName(path)
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

// Group by: what each choice is called in the menu, and the trigger's description.
const groupLabels: Record<GroupBy, { label: string; summary: string }> = {
  project: { label: 'Project', summary: 'Grouped by project' },
  date: { label: 'Date', summary: 'Grouped by date' },
  none: { label: 'None', summary: 'Not grouped' },
}
function relativeTime(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  // Whole days, so a thread from yesterday reads "1d", matching Group by date's sections.
  const days = Math.max(1, Math.floor((now - Date.parse(iso)) / 86_400_000))
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
// The sidebar's right-hand label for a thread: what it waits for; Done or Failed for a turn that
// ended while you weren't looking (until you open it); else when it last changed.
function threadTime(item: ThreadSummary, now: number, unread = false) {
  if (item.status === 'waiting') return item.waitingFor === 'question' ? 'Question' : 'Approval'
  if (unread && item.status === 'completed') return 'Done'
  if (unread && item.status === 'failed') return 'Failed'
  return relativeTime(item.updatedAt, now)
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
// "localhost:5173" for a page address (empty when unknown).
function siteOf(url?: string) {
  try {
    return url ? new URL(url).host : ''
  } catch {
    return ''
  }
}
// Work items with each run of consecutive steps gathered into one array (when grouping).
function groupSteps(items: WorkItem[], group: boolean) {
  const out: (WorkItem | Activity[])[] = []
  for (const item of items) {
    const last = out.at(-1)
    // A compaction stands on its own, as a divider, never folded into a run of steps.
    const step = item.kind === 'step' && !item.activity.compact
    if (group && step && Array.isArray(last)) last.push(item.activity)
    else out.push(group && step ? [item.activity] : item)
  }
  return out
}
function StatusDot({ status, unread = false }: { status: Status; unread?: boolean }) {
  // Working: the same pulsing dots as the live line at the bottom of the chat.
  if (status === 'starting' || status === 'working')
    return (
      <span className="live-dots status-working" role="img" aria-label={labels[status]}>
        <span />
        <span />
        <span />
        <span />
      </span>
    )
  if (unread && status !== 'waiting')
    return (
      <span
        className={`status-dot unread ${status}`}
        title={`${labels[status]} · not viewed yet`}
      />
    )
  return <span className={`status-dot ${status}`} title={labels[status]} />
}

// A project name short enough for a menu item.
const shortName = (name: string) => (name.length > 28 ? `${name.slice(0, 27)}…` : name)

// Long threads draw only their latest turns at first (a thread opens at the bottom, so that's
// all you'd see anyway); older turns are added as you scroll up. Like t3code's virtual list,
// but simpler: everything drawn stays real page content, so scroll pinning and find keep
// working on it.
const firstTurns = 12
const moreTurns = 20
// Where you were in a thread (this tab only): the oldest drawn turn, the turn at the top of the
// view and how far its top was from the view's top, and (when that turn isn't drawn) how far
// from the bottom.
type Place = {
  from?: string
  atBottom: boolean
  fromBottom: number
  anchor?: { turn: string; offset: number }
}
// The drawn turn at the top of the chat's view, and how far its top is from the view's top.
function topTurn(element: HTMLElement): Place['anchor'] {
  const top = element.getBoundingClientRect().top
  for (const turn of element.querySelectorAll<HTMLElement>('[data-turn]')) {
    const box = turn.getBoundingClientRect()
    if (box.bottom > top) return { turn: turn.dataset.turn!, offset: box.top - top }
  }
}

// Marks a search result's matched words in its message for a few seconds (CSS Custom
// Highlight API: no DOM changes, styled by ::highlight(search-match)). Browsers without it just
// scroll there.
function highlightMatch(element: HTMLElement, query: string) {
  const highlights = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)
    ?.highlights
  const Highlighter = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  const needle = query.toLowerCase()
  if (!highlights || !Highlighter || !needle) return
  const ranges: Range[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node && ranges.length < 20; node = walker.nextNode()) {
    const text = node.textContent?.toLowerCase() ?? ''
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      ranges.push(range)
    }
  }
  if (!ranges.length) return
  highlights.set('search-match', new Highlighter(...ranges))
  setTimeout(() => highlights.delete('search-match'), 4000)
}

// A search result being opened: scroll to its message once the thread is on screen (see the
// effect after drawnTurns in Workspace). Given up after a few seconds if the message never
// shows up. Kept outside the component, since going from the home page to a thread mounts a
// new Workspace.
const jump: {
  current: { thread: string; message: string; query: string; until: number } | null
} = { current: null }

// The top of a partly drawn thread: draws older turns once you scroll near it (well before
// you reach it), or when clicked.
function OlderTurns({
  count,
  root,
  onShow,
}: {
  count: number
  root: React.RefObject<HTMLDivElement | null>
  onShow: () => void
}) {
  const marker = useRef<HTMLButtonElement>(null)
  const show = useRef(onShow)
  show.current = onShow
  useEffect(() => {
    const element = marker.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) show.current()
      },
      { root: root.current, rootMargin: '1500px 0px 0px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [root])
  return (
    <button ref={marker} type="button" className="older-turns" onClick={() => show.current()}>
      Show {count} earlier {count === 1 ? 'turn' : 'turns'}
    </button>
  )
}

export function Workspace({ threadId }: { threadId?: string }) {
  const navigate = useNavigate()
  const activeId = threadId ?? null
  const selectedId = useRef(activeId)
  selectedId.current = activeId
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  // This computer's threads (its own live stream).
  const [localThreads, setThreads] = useState<ThreadSummary[]>([])
  // The hub (src/hub.ts): each machine's threads and projects, with hub ids, by machine id.
  const [hub, setHub] = useState<Record<string, HubState>>({})
  // The sidebar, ⌘K, and everything else see this computer's threads and every machine's.
  // Merged in the server's order, newest message first, so a machine's thread sits where its
  // time puts it, not after all of this computer's.
  const threads = useMemo(() => {
    const remote = Object.values(hub).flatMap((state) => state.threads)
    return remote.length
      ? [...localThreads, ...remote].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      : localThreads
  }, [localThreads, hub])
  // Online machines this sidebar shows (Settings → Machines), and a lookup for their names.
  const [machines, setMachines] = useState<HubMachine[]>([])
  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const hubMachine = (id: string): HubMachine =>
    machinesRef.current.find((machine) => machine.id === id) ?? { id, name: 'Machine' }
  // A thread a call returned, with its hub id when it's a machine's (as the sidebar shows it).
  const asShown = (shownId: string, value: Thread) => {
    const remote = parseRemote(shownId)
    return remote ? hubThread(hubMachine(remote.machine), value) : value
  }
  const [thread, setThread] = useState<Thread | null>(null)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [search, setSearch] = useState('')
  // The sidebar search also looks inside conversations: the server holds the messages, so it's
  // asked shortly after typing stops (one request at a time, the older one cancelled). Each
  // matching thread keeps a short excerpt of where it was found.
  const [contentMatches, setContentMatches] = useState<{
    query: string
    snippets: Map<string, string>
    // The message each excerpt came from, so clicking the result scrolls to it.
    messages: Map<string, string>
  }>({ query: '', snippets: new Map(), messages: new Map() })
  const contentQuery = search.trim()
  useEffect(() => {
    if (contentQuery.length < 2) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/search?limit=500&q=${encodeURIComponent(contentQuery)}`, {
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : { matches: [] }))
        .then((data: { matches?: MessageMatch[] }) =>
          setContentMatches({
            query: contentQuery,
            snippets: new Map((data.matches ?? []).map((match) => [match.threadId, match.snippet])),
            messages: new Map(
              (data.matches ?? []).map((match) => [match.threadId, match.messageId]),
            ),
          }),
        )
        .catch(() => {})
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [contentQuery])
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
  // The sidebar's project filter: one project's path, or "" for all (this browser only).
  const [projectFilter, setProjectFilterState] = useState('')
  useEffect(() => {
    try {
      setProjectFilterState(localStorage.getItem(projectFilterKey) ?? '')
    } catch {
      // Storage unavailable: show all projects.
    }
  }, [])
  function setProjectFilter(path: string) {
    setProjectFilterState(path)
    try {
      if (path) localStorage.setItem(projectFilterKey, path)
      else localStorage.removeItem(projectFilterKey)
    } catch {
      // Storage unavailable: it still applies until the page reloads.
    }
  }
  // Opening a thread from another project (⌘K, New thread) shows all projects again, so the
  // thread you just opened isn't hidden. Picking a project while one is open keeps the pick.
  const filterThread = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!thread || thread.id === filterThread.current) return
    filterThread.current = thread.id
    if (projectFilter && thread.cwd !== projectFilter) setProjectFilter('')
  }, [thread?.id, projectFilter])
  // Collapsed projects in the sidebar, remembered across reloads.
  const [collapsed, setCollapsedState] = useState<Record<string, boolean>>({})
  // Group by date: the sections you folded or opened yourself (this browser only). The rest
  // follow the default: only the newest section with threads is open (see isDateFolded).
  const [dateFolded, setDateFolded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(dateFoldedKey) ?? 'null')
      if (saved && typeof saved === 'object') setDateFolded(saved as Record<string, boolean>)
    } catch {
      // Unreadable: keep the defaults.
    }
  }, [])
  // By default only the newest section with threads is open (Today, else Yesterday, …); the
  // index is the section's place among the non-empty ones.
  const isDateFolded = (label: string, index: number) => dateFolded[label] ?? index > 0
  function toggleDateSection(label: string, folded: boolean) {
    setDateFolded((current) => {
      const next = { ...current, [label]: !folded }
      try {
        localStorage.setItem(dateFoldedKey, JSON.stringify(next))
      } catch {
        // Storage unavailable: it still applies until the page reloads.
      }
      return next
    })
  }
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
  // This browser's copy of the collapsed projects (shown at once on load).
  const keepCollapsed = (next: Record<string, boolean>) => {
    try {
      const paths = Object.keys(next).filter((path) => next[path])
      localStorage.setItem('t3-mini:collapsed-projects', JSON.stringify(paths))
    } catch {
      // Still applies for this session.
    }
  }
  function setCollapsed(
    update:
      Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>),
  ) {
    setCollapsedState((current) => {
      const next = typeof update === 'function' ? update(current) : update
      keepCollapsed(next)
      // The same in every browser and window (see shared-settings.ts).
      shareSetting({
        collapsed: Object.fromEntries(
          Object.keys(next)
            .filter((path) => next[path])
            .map((path) => [path, true]),
        ),
      })
      return next
    })
  }
  useEffect(
    () =>
      registerShared(
        'collapsed',
        () => {
          try {
            const saved: unknown = JSON.parse(
              localStorage.getItem('t3-mini:collapsed-projects') || '[]',
            )
            return Array.isArray(saved) && saved.length
              ? Object.fromEntries(
                  saved.filter((path) => typeof path === 'string').map((path) => [path, true]),
                )
              : undefined
          } catch {
            return undefined
          }
        },
        (shared) => {
          setCollapsedState(shared)
          keepCollapsed(shared)
        },
      ),
    [],
  )
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
  // Finished turns whose folded work you opened (keyed by turn).
  const [openTurns, setOpenTurns] = useState<Set<string>>(() => new Set())
  const toggleTurn = (key: string) =>
    setOpenTurns((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const [now, setNow] = useState(() => Date.now())
  const content = useRef<HTMLDivElement>(null)
  // Images waiting to be sent, per thread so switching threads keeps them.
  const [pending, setPending] = useState<Record<string, PendingAttachment[]>>({})
  // ↑ / ↓ in the composer walk through what you sent in this thread. `index` is the position
  // in that list; `text` is what was filled in, so typing over it hands the arrows back.
  const recalled = useRef<{ thread: string; index: number; text: string } | null>(null)
  // The message being edited (Edit under it, or ↑ after a stopped or failed turn); sending
  // replaces it.
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
  const threadCache = useRef(new RecentMap<string, Thread>(30))
  const notice = useRef<string | undefined>(undefined)
  // Threads this window is deleting. The live update that drops one often arrives before the
  // delete call returns; the "deleted elsewhere" handling skips these, so deleting the open
  // thread just moves on to the next one, without a "That thread was deleted." notice.
  const deleting = useRef(new Set<string>())
  const gitCache = useRef(new Map<string, GitInfo>())
  const [git, setGit] = useState<GitInfo | null>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const settleUntil = useRef(0)
  // Per thread: how much is drawn and where you were (see Place). Changing it re-renders.
  const places = useRef(new Map<string, Place>())
  const [, setPlacesVersion] = useState(0)
  const [jumpStep, setJumpStep] = useState(0)
  // Set just before older turns are drawn: the distance from the bottom to keep.
  const keepFromBottom = useRef<number | null>(null)
  // The thread on screen (clicking a thread shows its cached copy before the URL changes).
  const shownThread = useRef<string | undefined>(undefined)
  // The thread just clicked, until the URL catches up: its place is restored as soon as its
  // cached copy is drawn, so it never shows a frame at the bottom first.
  const selecting = useRef<string | null>(null)
  // Where a thread that's settling is held: the bottom (null), or your place in it.
  const hold = useRef<Place | null>(null)
  // Keeps the chat at the bottom while it's stuck there, and wherever it's held while it
  // settles (diagrams and images size themselves a moment after they're drawn). A place is
  // held by its turn, so content growing above or below it doesn't move you; only if that
  // turn isn't drawn, by the distance from the bottom.
  const pin = () => {
    const element = scrollArea.current
    if (!element) return
    const settling = Date.now() < settleUntil.current
    const place = settling ? hold.current : null
    if (place) {
      const turn = place.anchor
        ? element.querySelector<HTMLElement>(`[data-turn="${CSS.escape(place.anchor.turn)}"]`)
        : null
      if (turn && place.anchor) {
        const offset = turn.getBoundingClientRect().top - element.getBoundingClientRect().top
        element.scrollTop += offset - place.anchor.offset
      } else element.scrollTop = element.scrollHeight - place.fromBottom
    } else if (stickToBottom.current || settling) element.scrollTop = element.scrollHeight
  }
  // Back in a thread you'd scrolled up in: the same spot, measured from the bottom (new
  // messages since then are below you), held while the thread settles.
  const restorePlace = (id: string) => {
    const place = places.current.get(id)
    if (!place || place.atBottom) return
    stickToBottom.current = false
    settleUntil.current = Date.now() + 900
    hold.current = place
  }
  const composer = useRef<HTMLTextAreaElement>(null)
  const drafts = useRef(new Map<string, string>())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Working background music is playing in this tab (shows the radio character).
  const [musicPlaying, setMusicPlaying] = useState(false)
  const projectIcons = useProjectIcons()
  // How the sidebar lists threads: under their projects, one list, or one list by date. Kept on
  // the server, so every browser and window shows the same (it arrives with the bootstrap and
  // live updates).
  const [groupBy, setGroupBy] = useState<GroupBy>('project')
  function changeGroupBy(next: GroupBy) {
    setGroupBy(next)
    void api('ui-settings', 'POST', { groupBy: next }).catch((error: Error) =>
      setError(error.message),
    )
  }
  // 'system' on the server render; the saved choice is read after mount (already applied by the head script).
  const [theme, setTheme] = useState<Theme>('system')
  useEffect(() => {
    setTheme(loadTheme())
    // Changed in another browser or window.
    return onThemeChange(setTheme)
  }, [])
  function changeTheme(next: Theme) {
    setTheme(next)
    saveTheme(next)
  }
  const [menu, setMenu] = useState<
    | { kind: 'thread'; id: string; position: MenuPosition }
    | { kind: 'project'; path: string; position: MenuPosition }
    | null
  >(null)
  const [localProjects, setProjects] = useState<ProjectSummary[]>([])
  // Also in the server's order (latest activity first).
  const projects = useMemo(() => {
    const remote = Object.values(hub).flatMap((state) => state.projects)
    return remote.length
      ? [...localProjects, ...remote].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
      : localProjects
  }, [localProjects, hub])
  const projectName = (path: string) => projectLabel(projects, path)
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  // Threads whose agent has a browser page open (browser_* tools).
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([])
  // A newer t3mini installed (pushed with the live updates; see AppUpdate).
  const [appUpdate, setAppUpdate] = useState<AppUpdateState | null>(null)
  // Where the new-thread dialog starts; null while closed.
  const [newThreadProject, setNewThreadProject] = useState<string | null>(null)
  const [addProject, setAddProject] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  // The project whose settings are open (right-click a project or a thread), or null.
  const [projectSettings, setProjectSettings] = useState<string | null>(null)
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
        if (data.ui) {
          setGroupBy(data.ui.groupBy)
          applyShared(data.ui)
        }
        // Once: a choice this browser saved before the setting moved to the server.
        try {
          if (localStorage.getItem(groupByKey) === 'none' && data.ui?.groupBy !== 'none')
            changeGroupBy('none')
          localStorage.removeItem(groupByKey)
        } catch {
          // Storage unavailable: nothing to carry over.
        }
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
    // A machine's thread (the hub): its details come from that machine's stream, not this one.
    const remoteActive = parseRemote(activeId)
    // Load the thread directly too: a first visit shows up without waiting for the stream, and
    // a deleted thread gets a clear error.
    if (activeId)
      api<Thread>(threadApi(activeId), 'GET', undefined, controller.signal)
        .then((fetched) => {
          // A machine's thread gets its hub id (src/hub.ts).
          const loaded = remoteActive
            ? hubThread(hubMachine(remoteActive.machine), fetched)
            : fetched
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
      if (gone || !activeId || deleting.current.has(activeId)) return
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
    // The latest of each part, for checks that need parts that didn't change this time.
    let latest: { threads?: ThreadSummary[]; thread?: Thread | null; projects: ProjectSummary[] }
    const connect = () => {
      latest = { projects: [] }
      events = new EventSource(
        // patch=1: the open thread arrives whole once, then only what changed (thread-patch.ts).
        `/api/events?patch=1${activeId && !remoteActive ? `&thread=${encodeURIComponent(activeId)}` : ''}`,
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
        // Only the parts that changed since the last update (everything on connect); a missing
        // key means unchanged, so its state isn't replaced and doesn't re-render anything.
        const data = JSON.parse(event.data) as {
          threads?: ThreadSummary[]
          projects?: ProjectSummary[]
          thread?: Thread | null
          threadPatch?: ThreadPatch
          processes?: ProcessInfo[]
          browsers?: BrowserInfo[]
          ui?: UiSettings
          activeTab?: string | null
          persistenceError?: string | null
          appUpdate?: AppUpdateState
        }
        if (data.projects) {
          latest.projects = data.projects
          // Unchanged projects keep their objects (sidebar rows take them as props).
          const nextProjects = data.projects
          setProjects((current) => reuseItems(current, nextProjects, (project) => project.path))
        }
        if (data.processes) setProcesses(data.processes)
        if (data.browsers) setBrowsers(data.browsers)
        if (data.appUpdate) setAppUpdate(data.appUpdate)
        // Which tab, in any browser or profile, notifies and plays music.
        if (data.activeTab !== undefined) setServerTab(data.activeTab)
        if (data.ui) {
          setGroupBy(data.ui.groupBy)
          applyShared(data.ui)
        }
        if (data.threads) {
          latest.threads = data.threads
          announce(threadEvents(statuses.current, data.threads), latest.projects)
          statuses.current = new Map(data.threads.map((item) => [item.id, item.status]))
          // Unchanged threads keep their objects, so their sidebar rows don't re-render.
          const next = data.threads
          setThreads((current) => reuseItems(current, next))
        }
        // A machine's open thread is followed by that machine's stream (the hub effect).
        if (remoteActive) {
          if (data.persistenceError) setError(data.persistenceError)
          return
        }
        if (data.threadPatch) {
          // A patch applies to the thread this stream last sent; if that's missing (it can't
          // be, but just in case), start over and get the whole thread again.
          if (latest.thread?.id !== data.threadPatch.id) {
            events?.close()
            connect()
            return
          }
          data.thread = applyThreadPatch(latest.thread, data.threadPatch)
        }
        if (data.thread !== undefined) latest.thread = data.thread
        if (
          activeId &&
          !latest.thread &&
          latest.threads &&
          !latest.threads.some((item) => item.id === activeId)
        ) {
          leave()
          return
        }
        if (data.thread !== undefined) {
          // Unchanged messages and steps keep their objects, so only what changed re-renders.
          const next = data.thread
            ? reuseThread(threadCache.current.get(data.thread.id), data.thread)
            : null
          if (next) threadCache.current.set(next.id, next)
          // The next patch builds on this one, so its unchanged messages keep these objects.
          latest.thread = next
          setThread(next)
        }
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
  // The hub: the machines added under Settings → Machines, checked now and every minute. Only on
  // the computer itself (a paired phone can't manage machines). Offline ones drop out of the
  // sidebar until they answer again.
  useEffect(() => {
    if (!bootstrap || bootstrap.remote) return
    let cancelled = false
    const load = () =>
      api<MachineSummary[]>('machines')
        .then((list) => {
          if (cancelled) return
          const online = list
            .filter((machine) => machine.status === 'online')
            .map((machine) => ({ id: machine.id, name: machine.name }))
          setMachines((current) =>
            JSON.stringify(current) === JSON.stringify(online) ? current : online,
          )
        })
        .catch(() => {})
    void load()
    const timer = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [bootstrap])
  // One live stream per machine, through this server (/api/m/<machine>/events), merged into the
  // sidebar. The machine whose thread is open also streams that thread's details.
  const remoteActiveId = parseRemote(activeId)
  const activeMachine = remoteActiveId?.machine
  const activeOnMachine = remoteActiveId?.id
  useEffect(() => {
    // Forget machines that were removed or went offline.
    setHub((current) => {
      const kept = Object.fromEntries(
        Object.entries(current).filter(([id]) => machines.some((machine) => machine.id === id)),
      )
      return Object.keys(kept).length === Object.keys(current).length ? current : kept
    })
    const stops = machines.map((machine) => {
      const followed = machine.id === activeMachine ? activeOnMachine : undefined
      const hubStatuses = new Map<string, Status>()
      let source: EventSource | undefined
      let retry: ReturnType<typeof setTimeout> | undefined
      let attempts = 0
      let stopped = false
      const connect = () => {
        source = new EventSource(
          `/api/m/${encodeURIComponent(machine.id)}/events${followed ? `?thread=${encodeURIComponent(followed)}` : ''}`,
        )
        source.onopen = () => {
          attempts = 0
        }
        source.onerror = () => {
          if (source?.readyState !== EventSource.CLOSED) return
          source.close()
          if (!stopped) retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 30_000))
        }
        source.onmessage = (event) => {
          const data = JSON.parse(event.data) as {
            threads?: ThreadSummary[]
            projects?: ProjectSummary[]
            thread?: Thread | null
          }
          const threadsHere = data.threads?.map((item) => hubSummary(machine, item))
          const projectsHere = data.projects?.map((item) => hubProject(machine, item))
          if (threadsHere) {
            announce(threadEvents(hubStatuses, threadsHere), projectsHere ?? [])
            hubStatuses.clear()
            for (const item of threadsHere) hubStatuses.set(item.id, item.status)
          }
          if (threadsHere || projectsHere)
            setHub((current) => {
              const previous = current[machine.id] ?? { threads: [], projects: [] }
              return {
                ...current,
                [machine.id]: {
                  threads: threadsHere
                    ? reuseItems(previous.threads, threadsHere)
                    : previous.threads,
                  projects: projectsHere ?? previous.projects,
                },
              }
            })
          if (followed && data.thread !== undefined) {
            if (data.thread) {
              const loaded = reuseThread(
                threadCache.current.get(hubThread(machine, data.thread).id),
                hubThread(machine, data.thread),
              )
              threadCache.current.set(loaded.id, loaded)
              setThread(loaded)
            } else if (
              threadsHere &&
              !threadsHere.some((item) => item.id === activeId) &&
              !deleting.current.has(activeId ?? '')
            ) {
              // Deleted on the machine (or from another window): go home, like a local thread.
              threadCache.current.delete(activeId ?? '')
              notice.current = 'That thread was deleted.'
              void navigate({ to: '/', replace: true })
            }
          }
        }
      }
      connect()
      return () => {
        stopped = true
        clearTimeout(retry)
        source?.close()
      }
    })
    return () => stops.forEach((stop) => stop())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines, activeMachine, activeOnMachine])
  // The thread's git branch. Refreshed when the thread opens, after each turn (the agent may
  // switch branches), and when you come back to the window.
  const turnActive = thread ? isActive(thread.status) : false
  // The open thread's project, known from the sidebar list even before the thread loads.
  const activeCwd = thread?.cwd ?? threads.find((item) => item.id === activeId)?.cwd
  // Where it works, which is what git reports on: a worktree thread has its own branch.
  const gitFolder = thread?.worktree?.path ?? activeCwd
  useEffect(() => {
    setGit(gitFolder ? (gitCache.current.get(gitFolder) ?? null) : null)
    if (!activeId || !gitFolder) return
    const controller = new AbortController()
    const load = () =>
      api<GitInfo>(threadApi(activeId, 'git'), 'GET', undefined, controller.signal)
        .then((info) => {
          // Keep the last known pull request on screen while it's looked up again.
          const known = gitCache.current.get(gitFolder)
          const shown =
            known?.branch === info.branch && known.pullRequest
              ? { ...info, pullRequest: known.pullRequest }
              : info
          gitCache.current.set(gitFolder, shown)
          setGit(shown)
          // The pull request is a network lookup, so it follows the (instant) branch.
          if (!info.branch || info.detached || !info.url) return
          return api<{ pullRequest: PullRequest | null }>(
            threadApi(activeId, 'pull-request'),
            'GET',
            undefined,
            controller.signal,
          ).then(({ pullRequest }) => {
            const next = { ...info, pullRequest }
            gitCache.current.set(gitFolder, next)
            setGit((current) => (current?.branch === info.branch ? next : current))
          })
        })
        .catch(() => {})
    if (!turnActive) void load()
    window.addEventListener('focus', load)
    return () => {
      controller.abort()
      window.removeEventListener('focus', load)
    }
  }, [activeId, gitFolder, turnActive])
  useLayoutEffect(() => {
    // Keep the chat pinned to the bottom while it grows (streamed text, work log, status
    // lines) or while the chat area shrinks (a taller composer), unless the user scrolled up.
    // Only the chat container scrolls; scrollIntoView would also shift the outer layout.
    const element = scrollArea.current
    if (!element) return
    // Back at the bottom of a thread, only its latest turns are drawn again.
    const place = activeId ? places.current.get(activeId) : undefined
    if (place?.atBottom) delete place.from
    // Opening a thread lands at the bottom (or where you left it, see below): for a moment it
    // stays pinned no matter what, while messages load, images size themselves, and phone
    // scroll momentum settles.
    stickToBottom.current = true
    settleUntil.current = Date.now() + 900
    hold.current = null
    if (activeId && shownThread.current === activeId) restorePlace(activeId)
    selecting.current = null
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
    // The open thread, or the one just clicked (shown before the URL changes).
    if (loadedThread === activeId || loadedThread === selecting.current) restorePlace(loadedThread)
    pin()
  }, [loadedThread])
  // On a paired phone or tablet, a localhost link in the chat (an agent's "running at
  // http://localhost:3000/login") opens through t3 mini's preview address for that dev server,
  // at the same page, instead of the device's own localhost. On the computer they open as usual.
  const remoteView = Boolean(bootstrap?.remote)
  useEffect(() => {
    if (!remoteView) return
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('.chat-content a[href]')
      if (!(link instanceof HTMLAnchorElement) || !localDevUrl(link.href)) return
      event.preventDefault()
      void openPreview(link.href).catch((error: Error) => setError(error.message))
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [remoteView])
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
  // Unread threads come from the server (finished or failed while nobody was looking), so every
  // browser and device agrees. Opening one marks it read everywhere; `seen` hides the dot here
  // right away, before the server's update arrives.
  const [seen, setSeen] = useState<Set<string>>(() => new Set())
  const unread = new Set(
    threads.filter((item) => item.unread && !seen.has(item.id)).map((item) => item.id),
  )
  const unreadRef = useRef(unread)
  unreadRef.current = unread
  function markRead(id: string) {
    if (!unreadRef.current.has(id)) return
    setSeen((current) => new Set(current).add(id))
    void api(threadApi(id, 'read'), 'POST', {}).catch(() => {
      // Not saved: show it as unread again.
      setSeen((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    })
  }
  // The thread you're looking at is read, including one that was unread when the page loaded
  // (the thread list arrives after the page does).
  useEffect(() => {
    if (activeId && document.visibilityState === 'visible' && unread.has(activeId))
      markRead(activeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, activeId])
  // Forget `seen` entries once the server agrees, so a thread can be unread again later.
  useEffect(() => {
    setSeen((current) => {
      const still = [...current].filter((id) =>
        threads.some((item) => item.id === id && item.unread),
      )
      return still.length === current.size ? current : new Set(still)
    })
  }, [threads])
  // Tell the server which thread this tab shows and whether you're looking at it.
  useEffect(() => {
    const update = () => {
      const visible = document.visibilityState === 'visible'
      setTabView({
        ...(activeId ? { viewing: activeId } : {}),
        watching:
          visible && (document.hasFocus() || window.matchMedia('(pointer: coarse)').matches),
      })
    }
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [activeId])
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
    if (notifier && preferences.sound && events.some((event) => event.kind === 'completed'))
      playSound(preferences.soundName)
    // (Unread markers are set by the server, which knows whether you're watching anywhere.)
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
            `${projectLabel(projects, event.thread.cwd)} · ${names[event.thread.provider]} ${eventLabel(event).toLowerCase()}`,
            // One entry per thread (tag), but a newer one still pops up (renotify) instead of
            // silently replacing the last in Notification Center.
            {
              body: event.thread.title,
              tag: event.thread.id,
              renotify: true,
            } as NotificationOptions,
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
    // sidebar (in place of the browser's Save Page, which has no use here). ⌘K / Ctrl+K opens
    // the command palette (or closes it again).
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (bootstrap) setPaletteOpen((open) => !open)
      } else if (mod && event.shiftKey && event.key.toLowerCase() === 'o') {
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
      const text = event.clipboardData?.getData('text/plain')
      // Long text (logs, whole files) attaches as a file the agent reads.
      if (text && text.length > longPaste && (inComposer || canRedirect(event.target))) {
        if (!canAttach()) return
        event.preventDefault()
        attachTextRef.current(text)
        return
      }
      if (!canRedirect(event.target)) return
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
  // Highlighted chat text → "Add to chat": quoted at the end of the composer, on its own lines.
  // Stable, so the selection bar (memoized) never re-renders with the page.
  // Ask: the selection quoted, then the question, sent right away. With a draft or attachments
  // already in the composer it's added there instead (sending would take those along too).
  const askAbout = useCallback((text: string, question: string) => {
    const id = activeIdRef.current
    if (draftText.current.trim() || (id && pendingRef.current[id]?.length)) {
      quoteSelectionRef.current(text)
      insertTextRef.current(question, true)
      return
    }
    setDraft(quote(text) + question)
    void sendRef.current()
  }, [])
  const quoteSelection = useCallback((text: string) => {
    const draft = draftText.current
    const gap = !draft ? '' : draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n'
    insertTextRef.current(gap + quote(text), true)
    // The cursor goes under the quote, ready for your question, scrolled into view.
    const element = composer.current
    if (element) {
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
      element.scrollTop = element.scrollHeight
    }
  }, [])
  const quoteSelectionRef = useRef(quoteSelection)
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
        const uploaded = await uploadFile(prepared, 'image', apiBaseFor(threadId))
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
        const uploaded = await uploadFile(file, 'file', apiBaseFor(threadId))
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
  // A long paste becomes a "Pasted text" chip backed by a saved .txt file.
  async function attachText(text: string) {
    const threadId = activeId
    if (!threadId) return
    setError('')
    const file = new File([text], 'pasted-text.txt', { type: 'text/plain' })
    const item: PendingAttachment = {
      key: randomId(),
      name: 'Pasted text',
      previewUrl: '',
      status: 'uploading',
      size: file.size,
    }
    const update = (change: Partial<PendingAttachment> | null) =>
      setPending((current) => ({
        ...current,
        [threadId]: (current[threadId] || []).flatMap((entry) =>
          entry.key !== item.key ? [entry] : change ? [{ ...entry, ...change }] : [],
        ),
      }))
    setPending((current) => ({ ...current, [threadId]: [...(current[threadId] || []), item] }))
    try {
      const uploaded = await uploadFile(file, 'file', apiBaseFor(threadId))
      if (uploaded.kind === 'file') update({ status: 'ready', path: uploaded.path })
    } catch (error) {
      update(null)
      setError((error as Error).message)
    }
  }
  const attachTextRef = useRef(attachText)
  attachTextRef.current = attachText
  function removePending(key: string) {
    if (!activeId) return
    setPending((current) => ({
      ...current,
      [activeId]: (current[activeId] || []).filter((item) => {
        if (item.key === key && item.previewUrl) URL.revokeObjectURL(item.previewUrl)
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
    savePlace()
    setThread(threadCache.current.get(id) ?? null)
    setDraft(drafts.current.get(id) || '')
    setSidebarOpen(false)
    setError('')
    stickToBottom.current = true
    // Scrolling while the view switches isn't you moving around in either thread.
    settleUntil.current = Date.now() + 900
    hold.current = null
    selecting.current = id
  }
  function select(id: string, target?: { message: string; query: string }) {
    if (target) {
      jump.current = { thread: id, ...target, until: Date.now() + 8000 }
      setJumpStep((step) => step + 1)
    }
    prepareSelection(id)
    void navigate({ to: '/threads/$threadId', params: { threadId: id } })
  }
  openThread.current = select
  // After you send a message or start a thread, that thread moves to the top of the sidebar
  // (it's sorted by your latest message). Bring it into view there even if the list was
  // scrolled down. The reorder can arrive a moment later from the server, so it's watched
  // for a few seconds; a list you scroll yourself in the meantime is left alone.
  const threadList = useRef<HTMLElement>(null)
  const reveal = useRef<{ id: string; until: number } | null>(null)
  function revealThread(id: string) {
    reveal.current = { id, until: Date.now() + 3000 }
    revealNow()
  }
  function revealNow() {
    const target = reveal.current
    const list = threadList.current
    if (!target || !list) return
    if (Date.now() > target.until) {
      reveal.current = null
      return
    }
    const row = list.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(target.id)}"]`)
    const group = row?.closest<HTMLElement>('.project')
    if (!row || !group) return
    const view = list.getBoundingClientRect()
    const top = group.getBoundingClientRect().top - view.top + list.scrollTop
    const bottom = row.getBoundingClientRect().bottom - view.top + list.scrollTop
    // Show the project's header and the row; the first project scrolls all the way up.
    const padding = 8
    if (top - padding < list.scrollTop || bottom + padding > list.scrollTop + list.clientHeight)
      list.scrollTo({ top: Math.max(0, top - padding), behavior: 'smooth' })
  }
  useLayoutEffect(revealNow, [threads, projects])
  useEffect(() => {
    // Scrolling the list yourself (wheel, touch, keys) cancels a pending reveal.
    const list = threadList.current
    if (!list) return
    const stop = () => (reveal.current = null)
    list.addEventListener('wheel', stop, { passive: true })
    list.addEventListener('touchmove', stop, { passive: true })
    return () => {
      list.removeEventListener('wheel', stop)
      list.removeEventListener('touchmove', stop)
    }
  }, [])
  // (Sticking to the bottom is decided with the scroll position, in the layout effect above:
  // setting it here, after a restored place, would pull you to the bottom on the next resize.)
  useEffect(() => {
    setDraft(activeId ? drafts.current.get(activeId) || '' : '')
  }, [activeId])
  // Local or a new worktree, before the first message (the worktree is made on the first send).
  async function chooseWorktree(enabled: boolean) {
    if (!activeId || !thread || busy) return
    setBusy(true)
    setError('')
    try {
      const updated = asShown(
        activeId,
        await api<Thread>(threadApi(activeId, 'worktree'), 'POST', { enabled }),
      )
      if (selectedId.current === activeId) setThread(updated)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function updateSettings(settings: AgentSettings, provider = thread?.provider) {
    if (!activeId || !thread || busy) return
    setBusy(true)
    setError('')
    try {
      const updated = asShown(
        activeId,
        await api<Thread>(threadApi(activeId, 'settings'), 'POST', { ...settings, provider }),
      )
      rememberChoice(updated.provider, settings)
      if (selectedId.current === activeId) setThread(updated)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function quickCreate(cwd: string | null) {
    // One-click thread in an existing project (null: without a project, a chat), using the
    // last provider and settings.
    if (busy) return
    const preferences = loadPreferences()
    const provider = bootstrap ? defaultAgent(bootstrap, preferences) : 'claude'
    setBusy(true)
    setError('')
    try {
      // A machine's project (the hub): the thread is created there, in its folder.
      const remote = parseRemote(cwd)
      const created = remote
        ? hubThread(
            hubMachine(remote.machine),
            await api<Thread>(`m/${encodeURIComponent(remote.machine)}/threads`, 'POST', {
              provider,
              cwd: remote.id,
              ...settingsFor(provider, preferences),
            }),
          )
        : await api<Thread>('threads', 'POST', {
            provider,
            ...(cwd === null ? { noProject: true } : { cwd }),
            ...settingsFor(provider, preferences),
          })
      // A machine's thread joins the sidebar from its machine's stream a moment later.
      if (remote) threadCache.current.set(created.id, created)
      else
        setThreads((current) => [
          { ...created, lastMessageAt: created.createdAt },
          ...current.filter((item) => item.id !== created.id),
        ])
      select(created.id)
      revealThread(created.id)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // ↑ in an empty composer brings back your previous messages (↓ goes forward, then back to an
  // empty composer), like a shell or Claude Code. The arrows only do this on the first / last
  // line and while the recalled text is untouched, so editing a draft is never hijacked. The
  // most recent message after a stopped or failed turn opens in edit mode (Edit under the message
  // does that after a finished turn too).
  function recall(step: -1 | 1) {
    const element = composer.current
    if (!element || !thread || isActive(thread.status)) return false
    const caret = element.selectionStart ?? 0
    if (step < 0 && element.value.lastIndexOf('\n', caret - 1) !== -1) return false
    if (step > 0 && element.value.indexOf('\n', element.selectionEnd ?? caret) !== -1) return false
    const current = recalled.current?.thread === thread.id ? recalled.current : null
    const fresh = !element.value && !pending[thread.id]?.length
    if (current ? element.value !== current.text : !fresh || step > 0) return false
    const sent = sentMessages(thread)
    const index = (current?.index ?? sent.length) + step
    if (index < 0) return true
    const message = sent[index]
    recalled.current = message ? { thread: thread.id, index, text: message.text } : null
    fillComposer(thread, message)
    // ↑ opens edit mode only after a stopped or failed turn; after a finished one it recalls the
    // text for a new message (the Edit button under the message replaces a finished turn).
    const stopped = thread.status === 'interrupted' || thread.status === 'failed'
    setEditing(message && stopped && editableMessage(thread)?.id === message.id ? message.id : null)
    requestAnimationFrame(() =>
      element.setSelectionRange(element.value.length, element.value.length),
    )
    return true
  }
  // What you sent in a thread, oldest first: what ↑ / ↓ walk through.
  const sentMessages = (current: Thread) =>
    current.messages.filter(
      (message) =>
        message.role === 'user' && !message.report && (message.text || message.attachments?.length),
    )
  // Puts a sent message's text and images back in the composer (or clears it).
  function fillComposer(current: Thread, message: Message | undefined) {
    setDraft(message?.text ?? '')
    // Images go back as already-uploaded attachments.
    setPending((list) => ({
      ...list,
      [current.id]: (message?.attachments ?? []).map((item) => ({
        key: `recalled:${item.id}`,
        name: item.name,
        previewUrl: `${apiBaseFor(current.id)}/uploads/${encodeURIComponent(item.id)}`,
        status: 'ready' as const,
        id: item.id,
      })),
    }))
  }
  // Edit under your last message: open it in the composer in edit mode; sending replaces its turn.
  function startEdit(message: Message) {
    const element = composer.current
    if (!thread || !element || isActive(thread.status)) return
    if (editableMessage(thread)?.id !== message.id) return
    const sent = sentMessages(thread)
    recalled.current = {
      thread: thread.id,
      index: sent.findIndex((item) => item.id === message.id),
      text: message.text,
    }
    fillComposer(thread, message)
    setEditing(message.id)
    element.focus()
    requestAnimationFrame(() =>
      element.setSelectionRange(element.value.length, element.value.length),
    )
  }
  // Retry under your last message: run it again as it was, in place of its turn.
  async function retry(message: Message) {
    if (!thread || busy || !connected || isActive(thread.status)) return
    if (editableMessage(thread)?.id !== message.id) return
    const id = thread.id
    setBusy(true)
    setError('')
    stickToBottom.current = true
    try {
      await api(threadApi(id, 'edit'), 'POST', {
        messageId: message.id,
        text: message.text,
        attachments: (message.attachments ?? []).map((item) => ({ id: item.id, name: item.name })),
      })
      revealThread(id)
      // A message being edited in the composer has just been replaced.
      if (editing === message.id) cancelEdit()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const messageActions = useRef<MessageActions | null>(null)
  messageActions.current = { retry: (message) => void retry(message), edit: startEdit }
  function cancelEdit() {
    recalled.current = null
    setEditing(null)
    setDraft('')
    if (activeId) setPending((list) => ({ ...list, [activeId]: [] }))
    composer.current?.focus()
  }
  const sendRef = useRef(send)
  sendRef.current = send
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const pendingRef = useRef(pending)
  pendingRef.current = pending
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
      await api(threadApi(activeId, replacing ? 'edit' : 'send'), 'POST', {
        ...(replacing ? { messageId: replacing } : {}),
        text: withAttachedFiles(text, attached),
        attachments: attached
          .filter((item) => item.id)
          .map((item) => ({ id: item.id, name: item.name })),
      })
      revealThread(activeId)
      recalled.current = null
      setEditing(null)
      if (selectedId.current === activeId) setDraft('')
      drafts.current.delete(activeId)
      for (const item of attached) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      setPending((current) => ({ ...current, [activeId]: [] }))
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
      composer.current?.focus()
    }
  }
  // Turns you pressed Stop on (thread id → that turn's start), shown as stopped right away (like
  // Claude Desktop) until the server's update says so too, a moment later. Keyed by the turn,
  // so a message you send right after starts a turn that shows as working.
  const [stopping, setStopping] = useState<Map<string, string | undefined>>(() => new Map())
  const isStopping = (item: { id: string; startedAt?: string }) =>
    stopping.has(item.id) && stopping.get(item.id) === item.startedAt
  useEffect(() => {
    setStopping((current) => {
      const still = [...current].filter(([id]) => {
        const status = threads.find((entry) => entry.id === id)?.status
        return status !== undefined && isActive(status)
      })
      return still.length === current.size ? current : new Map(still)
    })
  }, [threads])
  async function stop() {
    if (!thread) return
    const { id, startedAt } = thread
    setStopping((current) => new Map(current).set(id, startedAt))
    // Once it has stopped, the live update clears it (above). A failed request (shown as an
    // error) leaves it running: back to the normal Stop button.
    if (await action('stop')) return
    setStopping((current) => {
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }
  // True when the request went through.
  async function action(path: string, body: unknown = {}) {
    setBusy(true)
    setError('')
    try {
      if (!activeId) return false
      await api(threadApi(activeId, path), 'POST', body)
      return true
    } catch (error) {
      setError((error as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  async function remove(target: Pick<ThreadSummary, 'id' | 'title'> | null = thread) {
    const summary = target && threads.find((item) => item.id === target.id)
    const branch = summary?.worktreeBranch
    if (
      !target ||
      !(await confirm({
        title: 'Delete this thread?',
        description: summary?.chat ? (
          <>
            <strong>{target.title}</strong> and its conversation will be removed from t3 mini. Its
            folder is removed too if it’s empty; files the agent made there stay.
          </>
        ) : branch ? (
          <>
            <strong>{target.title}</strong> and its conversation will be removed from t3 mini. Its
            worktree folder is removed too, unless it has uncommitted changes; the branch{' '}
            <strong>{branch}</strong> is kept.
          </>
        ) : (
          <>
            <strong>{target.title}</strong> and its conversation will be removed from t3 mini. Files
            in the project aren’t affected.
          </>
        ),
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return
    setBusy(true)
    const next = nextAfterDelete([target.id])
    deleting.current.add(target.id)
    try {
      keptWorktrees(await api<DeleteResult>(threadApi(target.id), 'DELETE', {}))
      forget(target.id, next)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      deleting.current.delete(target.id)
      setBusy(false)
    }
  }
  // Worktrees with uncommitted changes stay on disk when their thread is deleted: say where.
  function keptWorktrees(result: DeleteResult) {
    const kept = result.keptWorktrees ?? []
    if (kept.length)
      setError(
        `Kept ${kept.length === 1 ? 'a worktree' : `${kept.length} worktrees`} with uncommitted changes: ${kept.join(', ')}`,
      )
  }
  // Browser-side cleanup after a thread is deleted (the list itself updates live). If it was
  // the open one, next (see nextAfterDelete) opens instead of the empty screen.
  function forget(id: string, next: string | null = null) {
    drafts.current.delete(id)
    markRead(id)
    setToasts((current) => current.filter((item) => item.thread.id !== id))
    if (id === activeId) {
      threadCache.current.delete(id)
      if (next) return select(next)
      void navigate({ to: '/' })
      setThread(null)
      setDraft('')
    }
  }
  // The thread to open after deleting these ones when the open thread is among them: the most
  // recent left in its project, else the most recent of the rest, within the sidebar's project
  // filter. Null: nothing left, so the empty screen.
  function nextAfterDelete(gone: string[]) {
    if (!activeId || !gone.includes(activeId)) return null
    const project = threads.find((item) => item.id === activeId)?.cwd ?? thread?.cwd
    const left = threads
      .filter((item) => !gone.includes(item.id) && (!filterPath || item.cwd === filterPath))
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    return (left.find((item) => item.cwd === project) ?? left[0])?.id ?? null
  }
  // Deletes the picked threads after one confirmation. Running threads are kept (stop them
  // first, as with a single delete) and you're told how many.
  async function removeMany(ids: string[]) {
    const targets = threads.filter((item) => ids.includes(item.id))
    const running = targets.filter((item) => isActive(item.status))
    const deletable = targets.filter((item) => !isActive(item.status))
    if (!deletable.length) {
      setError('Those threads are still running. Stop them before deleting.')
      return
    }
    if (
      !(await confirm({
        title: `Delete ${plural(deletable.length, 'thread')}?`,
        description: (
          <>
            {deletable.length === 1 ? 'Its conversation' : 'Their conversations'} will be removed
            from t3 mini. Files in your projects aren’t affected.
            {running.length ? (
              <> {plural(running.length, 'thread')} still running will be kept.</>
            ) : null}
          </>
        ),
        confirmLabel: deletable.length === 1 ? 'Delete' : `Delete ${deletable.length}`,
        danger: true,
      }))
    )
      return
    setBusy(true)
    setError('')
    let failed = 0
    const next = nextAfterDelete(deletable.map((item) => item.id))
    for (const target of deletable) deleting.current.add(target.id)
    for (const target of deletable)
      try {
        keptWorktrees(await api<DeleteResult>(threadApi(target.id), 'DELETE', {}))
        forget(target.id, next)
      } catch {
        failed++
      }
    for (const target of deletable) deleting.current.delete(target.id)
    setPicked(new Set())
    if (failed) setError(`Couldn't delete ${plural(failed, 'thread')}. Try again.`)
    else if (running.length)
      setError(`Kept ${plural(running.length, 'running thread')}. Stop them before deleting.`)
    setBusy(false)
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
  // Removes a project from the sidebar after confirming, deleting its threads with it (the folder
  // and its files are never touched).
  async function removeProject(path: string) {
    const owned = threads.filter((item) => item.cwd === path)
    const name = projectName(path)
    const confirmed = await confirm({
      title: owned.length
        ? `Remove ${name} and its ${plural(owned.length, 'thread')}?`
        : `Remove ${name}?`,
      description: owned.length ? (
        <>
          {owned.length === 1 ? 'Its thread' : `All ${owned.length} of its threads`} and{' '}
          {owned.length === 1 ? 'its conversation' : 'their conversations'} will be deleted from t3
          mini. The project folder and its files aren’t touched.
        </>
      ) : (
        <>It’s only removed from the sidebar. The project folder and its files aren’t touched.</>
      ),
      confirmLabel: owned.length ? `Remove and delete ${plural(owned.length, 'thread')}` : 'Remove',
      danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    setError('')
    const next = nextAfterDelete(owned.map((item) => item.id))
    try {
      keptWorktrees(
        await api<DeleteResult>('projects', 'DELETE', { path, threads: owned.length > 0 }),
      )
      for (const item of owned) forget(item.id, next)
      setPicked(
        (current) => new Set([...current].filter((id) => !owned.some((item) => item.id === id))),
      )
      setProjects((current) => current.filter((project) => project.path !== path))
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const copyPath = (path: string) => void copyText(path).catch(() => {})
  // Styled confirmations (Base UI AlertDialog) instead of the browser's confirm().
  const [confirmDialog, confirm] = useConfirm()
  // Threads picked in the sidebar for a bulk action: ⌘/Ctrl-click toggles one, Shift-click picks
  // a range, and right-click → Select starts picking (phones); while any are picked, a plain
  // click toggles too. Esc clears.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const pickAnchor = useRef<string | null>(null)
  function togglePick(id: string) {
    pickAnchor.current = id
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  useEffect(() => {
    if (!picked.size) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setPicked(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked.size])
  // Threads whose title is being rewritten (Regenerate title), shown with a spinner.
  const [retitling, setRetitling] = useState<ReadonlySet<string>>(() => new Set())
  // A fresh AI title from the conversation; the sidebar updates through the live connection.
  async function regenerateTitle(id: string) {
    setError('')
    setRetitling((current) => new Set(current).add(id))
    try {
      await api(threadApi(id, 'title'), 'POST', {})
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
      await api(threadApi(id, 'rename'), 'POST', { title })
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
  // Projects stay put, newest added on top, so activity doesn't reshuffle them; only the
  // threads inside each project move (newest message first). A thread created a moment ago
  // may arrive before its project does, so fall back to thread folders.
  const projectPaths = [
    ...new Set([
      ...threads
        .map((item) => item.cwd)
        .filter((cwd) => !projects.some((project) => project.path === cwd)),
      ...[...projects]
        .sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''))
        .map((project) => project.path),
    ]),
  ]
  // The project picked in the sidebar's filter, while it still exists.
  const filterPath = projectFilter && projectPaths.includes(projectFilter) ? projectFilter : ''
  // Threads found inside their conversations (only for the query in the box, never a stale one).
  const foundIn =
    query && contentMatches.query === contentQuery ? contentMatches.snippets : undefined
  const visibleThreads = threads.filter(
    (item) =>
      (!filterPath || item.cwd === filterPath) &&
      (`${item.title} ${item.cwd}`.toLowerCase().includes(query) || foundIn?.has(item.id)),
  )
  const groups = projectPaths
    .filter((path) => !filterPath || path === filterPath)
    .map((path) => ({ path, items: visibleThreads.filter((item) => item.cwd === path) }))
    .filter(
      (group) =>
        !query ||
        group.items.length ||
        `${group.path} ${projectName(group.path)}`.toLowerCase().includes(query),
    )
  // Rows in sidebar order (open projects only), for Shift-click ranges; and the picked threads
  // that still exist.
  const visibleOrder =
    groupBy === 'date'
      ? dateSections(visibleThreads, now).flatMap((section, index) =>
          !isDateFolded(section.label, index) || query ? section.items.map((item) => item.id) : [],
        )
      : groupBy !== 'project'
        ? visibleThreads.map((item) => item.id)
        : groups.flatMap((group) =>
            !collapsed[group.path] || query ? group.items.map((item) => item.id) : [],
          )
  const pickedIds = threads.filter((item) => picked.has(item.id)).map((item) => item.id)
  function pickRange(id: string) {
    const from = visibleOrder.indexOf(pickAnchor.current ?? activeId ?? id)
    const to = visibleOrder.indexOf(id)
    if (from < 0 || to < 0) return togglePick(id)
    const range = visibleOrder.slice(Math.min(from, to), Math.max(from, to) + 1)
    setPicked((current) => new Set([...current, ...range]))
  }
  const active = thread ? isActive(thread.status) && !isStopping(thread) : false
  // Esc twice stops the open thread's agent, like Claude Code: the first press shows "Press Esc
  // again to stop", a second within a second stops it. Esc that closes a menu or dialog, cancels
  // an edit, or clears picked threads doesn't count.
  const [escHint, setEscHint] = useState(false)
  const escAt = useRef(0)
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => {
    escAt.current = 0
    setEscHint(false)
    if (!active || picked.size) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.repeat)
        return
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      )
        return
      if (Date.now() - escAt.current < 1000) {
        escAt.current = 0
        setEscHint(false)
        void stopRef.current()
      } else {
        escAt.current = Date.now()
        setEscHint(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, picked.size, thread?.id])
  useEffect(() => {
    if (!escHint) return
    const timer = setTimeout(() => setEscHint(false), 1000)
    return () => clearTimeout(timer)
  }, [escHint])
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
  // The message that can be edited or retried (your last, once its turn has ended).
  const editableId = thread ? editableMessage(thread)?.id : undefined
  // The edit bar shows only while the recalled message is still the one that can be edited.
  const editingMessage = Boolean(editing && editableId === editing)
  const composerPlaceholder = !thread
    ? ''
    : active
      ? `${names[thread.provider]} is working… send a message to steer it`
      : `Chat with ${names[thread.provider]}`
  const folder = thread ? projectName(thread.cwd) : undefined
  // The browser tab shows the open thread: "● Title · project — t3 mini" (● while the agent
  // works, ? while it waits for you), or just "t3 mini" with no thread open. It follows renames
  // and the AI title as they arrive.
  const tabTitle = thread
    ? `${thread.status === 'waiting' ? '? ' : isActive(thread.status) ? '● ' : ''}${thread.title} · ${folder} — t3 mini`
    : 't3 mini'
  useEffect(() => {
    document.title = tabTitle
  }, [tabTitle])
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
  const musicAgent: Provider =
    thread?.provider ??
    threads.find((item) => item.status === 'starting' || item.status === 'working')?.provider ??
    'claude'
  // The conversation one turn at a time (see timeline.ts). While the agent works, the step
  // it's on shows in the live line at the bottom instead of in the list.
  // Rebuilt only when the thread changes (not on every render), so the turn pieces handed to
  // memoized views keep their identity.
  const turns = useMemo(() => (thread ? buildTurns(thread) : []), [thread])
  // This thread's sub-agents still at work, for the chip under the composer. The same array
  // while they don't change, so the chip doesn't re-render as replies stream.
  const liveSubAgentsJson = useMemo(
    () =>
      JSON.stringify(
        (thread?.messages ?? []).flatMap((message) =>
          (message.blocks ?? []).filter(
            (block) =>
              block.type === 'delegation' &&
              (block.status === 'running' || block.status === 'waiting'),
          ),
        ),
      ),
    [thread?.messages],
  )
  const liveSubAgents = useMemo(
    () => JSON.parse(liveSubAgentsJson) as DelegationBlock[],
    [liveSubAgentsJson],
  )
  // "Worked for 24s · done 2:00 PM" under the thread once its latest turn has ended.
  const lastTurn = turns.at(-1)
  const finished =
    thread && !isActive(thread.status) && lastTurn?.done && lastTurn.user
      ? finishLabel(lastTurn, lastTurn.endedAt === thread.completedAt ? thread.status : undefined)
      : undefined
  // The preview steps through this thread's images (← / →).
  useEffect(
    () => setPreviewGallery(thread ? threadImages(thread.messages, apiBaseFor(thread.id)) : []),
    [thread],
  )
  shownThread.current = thread?.id
  // The drawn part: from the turn you'd scrolled back to, but at least the latest few.
  const place = thread ? places.current.get(thread.id) : undefined
  let firstDrawn = Math.max(0, turns.length - firstTurns)
  if (place?.from) {
    const index = turns.findIndex((turn) => turn.key === place.from)
    if (index >= 0) firstDrawn = Math.min(firstDrawn, index)
  }
  const drawnTurns = firstDrawn ? turns.slice(firstDrawn) : turns
  const showOlder = () => {
    const element = scrollArea.current
    if (!element || !thread || !firstDrawn) return
    keepFromBottom.current = element.scrollHeight - element.scrollTop
    places.current.set(thread.id, {
      atBottom: false,
      fromBottom: keepFromBottom.current,
      ...place,
      from: turns[Math.max(0, firstDrawn - moreTurns)]!.key,
    })
    setPlacesVersion((version) => version + 1)
  }
  // Opening a search result: draw the turn its message is in (and unfold it when the message is
  // one of the turn's folded notes), then scroll it into view a third of the way down, hold it
  // there while the thread settles (images and diagrams sizing), and highlight the match.
  useLayoutEffect(() => {
    const target = jump.current
    if (!target || !thread || thread.id !== target.thread) return
    if (Date.now() > target.until) {
      jump.current = null
      return
    }
    const index = turns.findIndex(
      (turn) =>
        turn.user?.id === target.message ||
        turn.answer?.id === target.message ||
        turn.replies.some((reply) => reply.id === target.message) ||
        turn.work.some((item) => item.kind === 'note' && item.message.id === target.message),
    )
    // Not in this copy (a cached one from before the message): the live copy comes next.
    if (index < 0) return
    const turn = turns[index]!
    if (index < firstDrawn) {
      places.current.set(thread.id, {
        atBottom: false,
        fromBottom: 0,
        ...places.current.get(thread.id),
        from: turn.key,
      })
      setJumpStep((step) => step + 1)
      return
    }
    const folded =
      turn.done &&
      turn.work.some((item) => item.kind === 'note' && item.message.id === target.message)
    if (folded && !openTurns.has(turn.key)) {
      setOpenTurns((current) => new Set(current).add(turn.key))
      return
    }
    const area = scrollArea.current
    const element = area?.querySelector<HTMLElement>(
      `[data-message="${CSS.escape(target.message)}"]`,
    )
    if (!area || !element) return
    jump.current = null
    const view = area.getBoundingClientRect()
    area.scrollTop += element.getBoundingClientRect().top - view.top - view.height / 3
    stickToBottom.current = false
    settleUntil.current = Date.now() + 900
    hold.current = {
      atBottom: false,
      fromBottom: area.scrollHeight - area.scrollTop,
      anchor: topTurn(area),
    }
    places.current.set(thread.id, {
      ...hold.current,
      from: turns[Math.min(index, firstDrawn)]!.key,
    })
    highlightMatch(element, target.query)
  }, [thread, turns, firstDrawn, openTurns, jumpStep])
  // Remembers where you are in this thread (on scroll, and again as you leave it, since
  // content may have finished sizing since you last scrolled).
  const savePlace = () => {
    const element = scrollArea.current
    if (!element || !thread || Date.now() < settleUntil.current) return
    places.current.set(thread.id, {
      ...(firstDrawn ? { from: turns[firstDrawn]!.key } : {}),
      atBottom: stickToBottom.current,
      fromBottom: element.scrollHeight - element.scrollTop,
      anchor: topTurn(element),
    })
  }
  // Older turns drawn above: stay on the same spot (the chat has no scroll anchoring).
  useLayoutEffect(() => {
    const element = scrollArea.current
    if (!element || keepFromBottom.current === null) return
    element.scrollTop = element.scrollHeight - keepFromBottom.current
    keepFromBottom.current = null
  }, [firstDrawn])
  const liveStep = active
    ? [...(thread?.activities ?? [])]
        .reverse()
        .find((item) => item.status === 'running' && !item.agent && !item.todo)
    : undefined
  const currentTodo = active
    ? thread?.todos?.find((todo) => todo.status === 'in_progress')
    : undefined
  const lastTodoAt = [...(thread?.activities ?? [])].reverse().find((item) => item.todo)?.startedAt
  // While a turn runs, its work stays folded behind the working line (like Claude Desktop): the
  // line shows the agent's latest note, and "N steps ›" opens everything so far (remembered for
  // that turn, like a finished turn's fold).
  const runningTurn = active ? turns.find((turn) => !turn.done) : undefined
  const runningOpen = runningTurn ? openTurns.has(runningTurn.key) : false
  const latestNote = runningTurn ? liveNote(runningTurn.work) : undefined
  const workToggle =
    runningTurn && runningTurn.work.some((item) => item.kind !== 'todos')
      ? {
          steps: runningTurn.steps,
          open: runningOpen,
          onToggle: () => toggleTurn(runningTurn.key),
        }
      : {}
  // In a finished turn the notes' images live with the answer, so notes show just their text.
  // While the turn runs, consecutive steps collapse into one line (StepGroup); the folded
  // view of a finished turn lists every step.
  const workList = (items: WorkItem[], folded = false) => (
    <div className="work">
      {groupSteps(
        items.filter((item) => item.kind !== 'step' || item.activity !== liveStep),
        !folded,
      ).map((item) =>
        Array.isArray(item) ? (
          <StepGroup key={item[0]!.id} steps={item} />
        ) : item.kind === 'note' ? (
          folded && !item.message.text.trim() ? null : (
            <MessageView
              key={item.message.id}
              message={item.message}
              meta={false}
              {...(folded ? { blocks: noBlocks } : {})}
            />
          )
        ) : item.kind === 'todos' ? (
          item.todos.length ? (
            <TodoCard key="todos" todos={item.todos} ended={folded} />
          ) : null
        ) : item.activity.compact ? (
          <CompactMarker key={item.activity.id} step={item.activity} />
        ) : (
          <StepRow key={item.activity.id} step={item.activity} />
        ),
      )}
    </div>
  )

  // A thread's time, which doubles as its status, for the ⌘K palette (sidebar rows draw their
  // own, see ThreadRow).
  const threadStatus = (item: ThreadSummary) =>
    item.status === 'starting' || item.status === 'working' ? (
      <span className="thread-time working">
        <StatusDot status={item.status} />
      </span>
    ) : retitling.has(item.id) ? (
      <span className="thread-time working">
        <LoaderCircle size={12} className="status-spinner" aria-label="Writing a new title" />
      </span>
    ) : (
      <span
        className={`thread-time ${item.status} ${unread.has(item.id) ? 'unread' : ''}`}
        title={item.status === 'failed' ? labels.failed : undefined}
      >
        {threadTime(item, now, unread.has(item.id))}
      </span>
    )
  // One thread in the sidebar (with its project's name when the list isn't grouped).
  const threadRow = (item: ThreadSummary, showProject = false) =>
    renaming?.id === item.id ? (
      <div className="thread-row selected renaming" key={item.id}>
        <input
          className="thread-rename"
          aria-label="Thread name"
          autoFocus
          maxLength={120}
          value={renaming.title}
          onFocus={(event) => event.target.select()}
          onChange={(event) => setRenaming({ id: item.id, title: event.target.value })}
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
      <ThreadRow
        key={item.id}
        item={item}
        actions={rowActions}
        showProject={showProject}
        projectName={showProject ? projectName(item.cwd) : ''}
        icons={projectIcons}
        project={
          showProject && projectIcons
            ? projects.find((project) => project.path === item.cwd)
            : undefined
        }
        selected={activeId === item.id}
        unread={unread.has(item.id)}
        picked={picked.has(item.id)}
        picking={picked.size > 0}
        busy={busy}
        retitling={retitling.has(item.id)}
        time={threadTime(item, now, unread.has(item.id))}
        menuOpen={menu?.kind === 'thread' && menu.id === item.id}
        snippet={
          foundIn?.has(item.id) && !item.title.toLowerCase().includes(query)
            ? nearMatch(foundIn.get(item.id)!, query)
            : undefined
        }
      />
    )
  // What a sidebar row does when used. Read through a ref, so the memoized rows never need new
  // props for it: they always call the latest version.
  const rowActions = useRef<RowActions>(null!)
  rowActions.current = {
    click: (event, id) => {
      if (busy) {
        event.preventDefault()
        return
      }
      // Picking threads instead of opening one (middle-click still opens a new tab).
      if (event.button === 0 && (event.metaKey || event.ctrlKey || event.shiftKey || picked.size)) {
        event.preventDefault()
        if (event.shiftKey) pickRange(id)
        else togglePick(id)
        return
      }
      if (!event.altKey && event.button === 0) {
        // Found inside its conversation (the excerpt is shown): open it at that message.
        const message = foundIn?.get(id) && contentMatches.messages.get(id)
        if (
          message &&
          !threads
            .find((item) => item.id === id)
            ?.title.toLowerCase()
            .includes(query)
        )
          jump.current = { thread: id, message, query: contentQuery, until: Date.now() + 8000 }
        // (Already open: nothing else changes, so run the jump now.)
        if (message) setJumpStep((step) => step + 1)
        prepareSelection(id)
      }
    },
    contextMenu: (event, id) => {
      event.preventDefault()
      setMenu({ kind: 'thread', id, position: menuPosition(event) })
    },
    rename: (id, title) => setRenaming({ id, title }),
    more: (event, id) => {
      const rect = event.currentTarget.getBoundingClientRect()
      setMenu({ kind: 'thread', id, position: { x: rect.left, y: rect.bottom + 4 } })
    },
  }
  return (
    // Images, media, and pages in the open thread load from where it lives (the hub).
    <ApiBase.Provider value={apiBaseFor(activeId)}>
      <div className="workspace">
        {confirmDialog}
        {/* Working background music (off unless turned on in Settings). */}
        <BackgroundMusic
          working={threads.some((item) => item.status === 'starting' || item.status === 'working')}
          onPlayingChange={setMusicPlaying}
        />
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
                onClick={() => setPaletteOpen(true)}
                disabled={!bootstrap}
                aria-label="Search"
                title={`Search (${isMac ? '⌘K' : 'Ctrl+K'})`}
              >
                <Search size={15} />
              </button>
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
              {/* Which project's threads to show: all, or one. */}
              <span className="sidebar-section-label">
                <ProjectFilter
                  value={filterPath}
                  paths={projectPaths}
                  projects={projects}
                  projectName={projectName}
                  projectIcons={projectIcons}
                  onChange={setProjectFilter}
                />
              </span>
              {/* View options (like Claude Desktop): group threads by project, by date, or not at
                all. */}
              <SettingsMenu
                label="Sidebar view"
                text={groupLabels[groupBy].summary}
                title="View options"
                triggerClassName="icon-button sidebar-view"
                trigger={<Settings2 size={13} />}
                placement="down"
                rows={[
                  {
                    key: 'group',
                    label: 'Group by',
                    text: groupLabels[groupBy].label,
                    value: groupBy,
                    options: (['project', 'date', 'none'] as const).map((value) => ({
                      value,
                      label: groupLabels[value].label,
                    })),
                    onSelect: (value) =>
                      changeGroupBy(value === 'none' || value === 'date' ? value : 'project'),
                    closeOnSelect: true,
                  },
                ]}
              />
              {groupBy !== 'project'
                ? null
                : (() => {
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
          <nav className="thread-list" aria-label="Threads" ref={threadList}>
            {groupBy === 'none' && groups.length ? (
              // One list, newest message first, each thread with its project's name.
              <section className="project recents">
                {visibleThreads.map((item) => threadRow(item, !filterPath))}
              </section>
            ) : null}
            {groupBy === 'date' && groups.length
              ? // The same list, split by when you last wrote in each thread (its own order, so
                // each section stays in one piece). Empty sections are left out.
                // Each section folds from its heading (the chevron shows on hover); search opens all.
                dateSections(visibleThreads, now).map((section, index) => {
                  const folded = isDateFolded(section.label, index)
                  const open = !folded || Boolean(query)
                  return (
                    <section
                      className="project recents"
                      key={section.label}
                      aria-label={section.label}
                    >
                      <button
                        type="button"
                        className={`date-heading ${open ? 'open' : ''}`}
                        aria-expanded={open}
                        onClick={() => toggleDateSection(section.label, folded)}
                      >
                        <span>{section.label}</span>
                        <ChevronRight size={12} className="fold-chevron" aria-hidden />
                      </button>
                      {open ? section.items.map((item) => threadRow(item, !filterPath)) : null}
                    </section>
                  )
                })
              : null}
            {(groupBy === 'project' ? groups : []).map(({ path: cwd, items }) => (
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
                      {projectIcons ? (
                        <ProjectAvatar
                          path={cwd}
                          name={projectName(cwd)}
                          project={projects.find((project) => project.path === cwd)}
                        />
                      ) : collapsed[cwd] ? (
                        <Folder size={14} />
                      ) : (
                        <FolderOpen size={14} />
                      )}
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
                      className={`project-toggle ${collapsed[cwd] ? '' : 'open'}`}
                      // Folds and unfolds; renaming is in the right-click menu.
                      onClick={() => setCollapsed({ ...collapsed, [cwd]: !collapsed[cwd] })}
                      aria-expanded={!collapsed[cwd]}
                      title={machinePath(cwd)}
                    >
                      {projectIcons ? (
                        <ProjectAvatar
                          path={cwd}
                          name={projectName(cwd)}
                          project={projects.find((project) => project.path === cwd)}
                        />
                      ) : collapsed[cwd] ? (
                        <Folder size={14} />
                      ) : (
                        <FolderOpen size={14} />
                      )}
                      <span>{projectName(cwd)}</span>
                      {isRemote(cwd) ? (
                        <MachineTag name={hubMachine(parseRemote(cwd)!.machine).name} />
                      ) : null}
                      <ChevronRight size={12} className="fold-chevron" aria-hidden />
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
                {!collapsed[cwd] || query ? items.map((item) => threadRow(item)) : null}
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
          {pickedIds.length ? (
            <div className="selection-bar" role="toolbar" aria-label="Selected threads">
              <span>{pickedIds.length} selected</span>
              <button
                type="button"
                className="link-button selection-cancel"
                onClick={() => setPicked(new Set())}
              >
                Cancel
              </button>
              <button
                type="button"
                className="secondary selection-delete"
                disabled={busy}
                onClick={() => void removeMany(pickedIds)}
              >
                <Trash2 size={13} />
                Delete
              </button>
            </div>
          ) : null}
          <AppUpdate
            enabled={Boolean(bootstrap && !bootstrap.remote)}
            running={runningCount}
            live={appUpdate}
          />
          <ProviderUpdates
            enabled={Boolean(bootstrap && !bootstrap.remote)}
            onUpdated={updatedProvider}
          />
          <div className="sidebar-footer">
            <div
              className="connection"
              role="status"
              title={
                connected ? 'Connected to the local server' : 'Reconnecting to the local server'
              }
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
            {/* A reminder on the Mac while other devices can connect. */}
            {bootstrap?.phoneAccess && !bootstrap.remote ? (
              <button
                className="icon-button phone-on"
                aria-label="Other devices can connect. Open settings"
                title="Other devices can connect"
                onClick={() => setSettingsOpen(true)}
              >
                <MonitorSmartphone size={14} />
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
          <SidebarResize />
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
                {musicPlaying ? (
                  // The open thread's agent (or a working one's) with its radio.
                  <img
                    className={`music-mascot ${musicAgent}`}
                    src={`/mascots/${musicAgent}-radio.gif`}
                    alt=""
                    width={32}
                    height={32}
                    title="Working background music is playing"
                  />
                ) : null}
                {thread && retitling.has(thread.id) ? (
                  <LoaderCircle
                    size={13}
                    className="status-spinner"
                    aria-label="Writing a new title"
                  />
                ) : null}
                {/* A breadcrumb: the project, then the thread ("[avatar] nighteye / Fix the login").
                  The project part is hidden on phones, where there's only room for the title. */}
                {thread ? (
                  <>
                    <span className="topbar-project" title={machinePath(thread.cwd)}>
                      {projectIcons ? (
                        <ProjectAvatar
                          path={thread.cwd}
                          name={folder ?? ''}
                          project={projects.find((project) => project.path === thread.cwd)}
                        />
                      ) : (
                        <FolderOpen size={13} />
                      )}
                      <span>{folder}</span>
                      {thread.machine ? <MachineTag name={thread.machine} /> : null}
                    </span>
                    <span className="topbar-separator" aria-hidden>
                      /
                    </span>
                    {/* A helper thread or a sub-agent: its lead, one step up the breadcrumb. */}
                    {thread.parentId || thread.delegateOf ? (
                      <>
                        <Link
                          className="topbar-lead"
                          to="/threads/$threadId"
                          params={{ threadId: (thread.parentId ?? thread.delegateOf)! }}
                          title={
                            thread.delegateOf
                              ? 'The thread this sub-agent works for'
                              : 'The lead thread that started this helper'
                          }
                        >
                          {thread.delegateOf ? (
                            <Bot size={13} aria-hidden />
                          ) : (
                            <Workflow size={13} aria-hidden />
                          )}
                          <span>
                            {threads.find(
                              (item) => item.id === (thread.parentId ?? thread.delegateOf),
                            )?.title ?? 'Lead thread'}
                          </span>
                        </Link>
                        <span className="topbar-separator" aria-hidden>
                          /
                        </span>
                      </>
                    ) : null}
                  </>
                ) : null}
                <strong>{thread?.title || (activeId ? 'Loading…' : 't3 mini')}</strong>
              </div>
              <div className="topbar-actions">
                {thread ? (
                  <>
                    {/* VS Code is on this computer, so not for a machine's thread. */}
                    {bootstrap?.editors?.vscode && !bootstrap.remote && !thread.machine ? (
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
              {/* While the agent works: a thin sliding bar along the header's bottom edge, like a
                terminal's progress bar. Not while it waits on you (an approval or a question). */}
              {active && thread?.status !== 'waiting' ? (
                <div className="working-bar" role="progressbar" aria-label="Agent is working" />
              ) : null}
            </header>
            <div className="chat-column">
              <SelectionActions root={scrollArea} onQuote={quoteSelection} onAsk={askAbout} />
              <div
                className="chat-scroll"
                ref={scrollArea}
                onScroll={() => {
                  const element = scrollArea.current
                  // Scroll positions while a thread is still settling aren't the user's choice.
                  if (!element || Date.now() < settleUntil.current) return
                  stickToBottom.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 120
                  savePlace()
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
                      {firstDrawn ? (
                        <OlderTurns
                          key={firstDrawn}
                          count={firstDrawn}
                          root={scrollArea}
                          onShow={showOlder}
                        />
                      ) : null}
                      {drawnTurns.map((turn, index) => (
                        <div className="turn" key={turn.key} data-turn={turn.key}>
                          {/* The thread switched agents at this turn (server/handoff.ts). */}
                          {turn.user?.provider &&
                          drawnTurns[index - 1]?.user?.provider &&
                          drawnTurns[index - 1]!.user!.provider !== turn.user.provider ? (
                            <div
                              className="agent-switch"
                              role="note"
                              title="This agent got a recap of the conversation before this turn."
                            >
                              <span className="agent-switch-rule" aria-hidden />
                              <span className="agent-switch-label">
                                <ProviderMark provider={turn.user.provider} size={12} />
                                Switched to {providerNames[turn.user.provider]}
                              </span>
                              <span className="agent-switch-rule" aria-hidden />
                            </div>
                          ) : null}
                          {turn.user ? (
                            <MessageView
                              message={turn.user}
                              editable={turn.user.id === editableId}
                              actions={messageActions}
                            />
                          ) : null}
                          {turn.done && turn.work.length ? (
                            <div className={`turn-fold ${openTurns.has(turn.key) ? 'open' : ''}`}>
                              <button
                                type="button"
                                className="turn-fold-toggle"
                                aria-expanded={openTurns.has(turn.key)}
                                onClick={() => toggleTurn(turn.key)}
                              >
                                <span>
                                  {foldLabel(
                                    turn,
                                    turn.endedAt === thread.completedAt ? thread.status : undefined,
                                  )}
                                </span>
                                <ChevronRight size={13} className="chevron" />
                              </button>
                              {openTurns.has(turn.key) ? (
                                workList(turn.work, true)
                              ) : unfinished(turn) ? (
                                // Ended with items left: the checklist stays in view, so what
                                // wasn't done is plain without opening the turn.
                                <div className="work">
                                  <TodoCard todos={turn.todos!} ended />
                                </div>
                              ) : null}
                            </div>
                          ) : !turn.done && turn.work.length ? (
                            openTurns.has(turn.key) ? (
                              workList(turn.work)
                            ) : turn.todos?.length || turn.cards.length ? (
                              // Folded: the to-do checklist and status cards stay in view, live,
                              // since they're the progress you're following.
                              <div className="work">
                                {turn.todos?.length ? <TodoCard todos={turn.todos} /> : null}
                                {turn.cards.length ? <Blocks blocks={turn.cards} /> : null}
                              </div>
                            ) : null
                          ) : null}
                          {/* Replies the agent ended a response with before its last one (e.g. a
                            summary, then a follow-up once background work finished): kept in
                            view, in order, with what it showed while working above the first. */}
                          {turn.replies.map((reply, index) => (
                            <MessageView
                              key={reply.id}
                              message={reply}
                              {...(index === 0 ? { leading: turn.blocks } : {})}
                            />
                          ))}
                          {turn.answer ? (
                            <MessageView
                              message={turn.answer}
                              {...(turn.replies.length ? {} : { leading: turn.blocks })}
                            />
                          ) : null}
                        </div>
                      ))}
                      {thread.approvals.map((approval) =>
                        approval.questions?.length ? (
                          <QuestionCard
                            key={approval.id}
                            approval={{ ...approval, questions: approval.questions }}
                            disabled={busy || !connected}
                            onAnswer={(answers) =>
                              action('approve', { approvalId: approval.id, allow: true, answers })
                            }
                            onSkip={() =>
                              action('approve', { approvalId: approval.id, allow: false })
                            }
                          />
                        ) : (
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
                        ),
                      )}
                      {finished ? (
                        <div className="thread-end" role="status">
                          <span>{finished}</span>
                        </div>
                      ) : null}
                      {/* Work Claude left running in the background (e.g. a subagent) keeps the turn
                        open after its last reply; say so, so it doesn't look stuck. */}
                      {active && thread.background?.length ? (
                        <div className="background-tasks" role="status">
                          <LoaderCircle size={13} className="status-spinner" />
                          <span>
                            Still running in the background:{' '}
                            <strong>
                              {thread.background.map((task) => task.description).join(', ')}
                            </strong>
                          </span>
                        </div>
                      ) : null}
                      {/* What the agent is doing right now, and for how long. */}
                      {active && !thread.approvals.length ? (
                        latestNote && !runningOpen ? (
                          // Folded: the agent's latest note, and how long the turn has run.
                          <LiveLine
                            text={latestNote}
                            note
                            since={thread.startedAt}
                            provider={thread.provider}
                            mood={liveStep ? 'working' : 'thinking'}
                            {...workToggle}
                          />
                        ) : liveStep ? (
                          <LiveLine
                            text={stepTitle(liveStep)}
                            since={liveStep.startedAt}
                            provider={thread.provider}
                            mood={liveStep.compact ? 'thinking' : 'working'}
                            compacting={Boolean(liveStep.compact)}
                            {...workToggle}
                            // A browser step names the site it's on (opening one already does).
                            {...(liveStep.browser
                              ? {
                                  site:
                                    liveStep.label === 'Open page'
                                      ? ''
                                      : siteOf(
                                          browsers.find((item) => item.threadId === thread.id)?.url,
                                        ),
                                }
                              : {})}
                          />
                        ) : currentTodo ? (
                          // Between steps, the checklist's current item in its "-ing" form.
                          <LiveLine
                            text={currentTodo.activeText || currentTodo.text}
                            since={lastTodoAt ?? thread.startedAt}
                            provider={thread.provider}
                            mood="working"
                            {...workToggle}
                          />
                        ) : (
                          <LiveLine
                            text={thread.status === 'starting' ? 'Starting…' : 'Thinking…'}
                            since={thread.startedAt}
                            provider={thread.provider}
                            mood="thinking"
                            {...workToggle}
                          />
                        )
                      ) : thread.status === 'completed' && thread.completedAt ? (
                        <Celebration provider={thread.provider} at={thread.completedAt} />
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
                  <ScrollToBottom scrollArea={scrollArea} stickToBottom={stickToBottom} />
                  {escHint && active ? (
                    <div className="esc-hint" role="status">
                      Press <kbd>Esc</kbd> again to stop
                    </div>
                  ) : null}
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
                            Editing your last message · it replaces that turn{' '}
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
                              className={`pending-image ${item.status}${item.previewUrl ? '' : ' pending-file'}`}
                              key={item.key}
                              title={item.name}
                            >
                              {item.previewUrl ? (
                                <img src={item.previewUrl} alt={item.name} />
                              ) : (
                                <>
                                  <FileText size={16} />
                                  <span className="pending-file-text">
                                    <strong>{item.name}</strong>
                                    {item.size !== undefined ? (
                                      <span>{formatSize(item.size)}</span>
                                    ) : null}
                                  </span>
                                </>
                              )}
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
                                    // Switching agents brings back that agent's last-used settings,
                                    // or the ones picked in its tab (model, effort, tier).
                                    onChange: (provider, settings) => {
                                      if (provider === thread.provider) return
                                      void updateSettings(
                                        settings ?? settingsFor(provider),
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
                          {/* One button at a time: while the agent works, Stop until there's
                            something to send (text or an image), then Send, which steers it. */}
                          {active && !hasDraft && !pending[thread.id]?.length ? (
                            <button
                              className="stop-button"
                              type="button"
                              aria-label="Stop"
                              title="Stop (Esc Esc)"
                              onClick={() => void stop()}
                              disabled={!connected}
                            >
                              <Square size={10} fill="currentColor" />
                            </button>
                          ) : null}
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
                  (git?.branch ||
                    processes.some((item) => item.project === thread.cwd) ||
                    browsers.some((item) => item.threadId === thread.id)) ? (
                    <div className="composer-meta">
                      {/* Branch and its pull request stay together on the left. */}
                      <span className="git-info">
                        {/* Where the thread works: chosen before the first message, then a
                          Worktree badge for the rest of the thread. */}
                        {git?.branch && !thread.worktree && !thread.messages.length ? (
                          <Picker
                            label="Work in"
                            icon={
                              thread.useWorktree ? <FolderGit2 size={12} /> : <Folder size={12} />
                            }
                            text={thread.useWorktree ? 'New worktree' : 'Local'}
                            value={thread.useWorktree ? 'worktree' : 'local'}
                            options={[
                              {
                                value: 'local',
                                label: 'Local',
                                description: 'Work in the project folder',
                              },
                              {
                                value: 'worktree',
                                label: 'New worktree',
                                description: `Its own checkout on a new branch, from ${git.branch}`,
                              },
                            ]}
                            onSelect={(value) => void chooseWorktree(value === 'worktree')}
                            disabled={busy || !connected}
                            placement="up"
                          />
                        ) : thread.worktree ? (
                          <span
                            className="worktree-badge"
                            title={`Worktree: ${thread.worktree.path}`}
                          >
                            <FolderGit2 size={12} />
                            <span>Worktree</span>
                          </span>
                        ) : null}
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
                        {git?.pullRequest ? (
                          // The branch's pull request on GitHub, in a new tab.
                          <a
                            className="git-pr"
                            href={git.pullRequest.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`Open pull request #${git.pullRequest.number} on GitHub`}
                          >
                            <GitPullRequest size={12} />
                            <span>#{git.pullRequest.number}</span>
                          </a>
                        ) : null}
                      </span>
                      {/* The agent's open browser page, then dev servers and other processes. */}
                      <span className="composer-meta-chips">
                        <BrowserChip
                          threadId={thread.id}
                          browser={browsers.find((item) => item.threadId === thread.id)}
                        />
                        <ProcessIndicator
                          processes={processes}
                          project={thread.cwd}
                          remote={Boolean(bootstrap?.remote)}
                        />
                        <SubAgentChip live={liveSubAgents} />
                      </span>
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
              if (menu.kind === 'thread' && picked.has(menu.id) && pickedIds.length > 1) {
                // Right-click inside a selection acts on all of it.
                items = [
                  {
                    label: `Delete ${pickedIds.length} threads`,
                    icon: <Trash2 size={14} />,
                    danger: true,
                    disabled: busy,
                    onSelect: () => void removeMany(pickedIds),
                  },
                  {
                    label: 'Clear selection',
                    icon: <X size={14} />,
                    onSelect: () => setPicked(new Set()),
                  },
                ]
              } else if (menu.kind === 'thread') {
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
                  'separator',
                  {
                    label: `New thread in ${shortName(projectName(target.cwd))}`,
                    icon: <SquarePen size={14} />,
                    onSelect: () => void quickCreate(target.cwd),
                  },
                  // A machine's thread (the hub): its project's settings and read_thread links
                  // belong to that machine, so they aren't offered here.
                  ...(isRemote(target.id)
                    ? []
                    : [
                        {
                          label: 'Project settings…',
                          icon: <Settings2 size={14} />,
                          onSelect: () => setProjectSettings(target.cwd),
                        },
                        {
                          // Paste it into another thread so its agent can read this one (read_thread).
                          label: 'Copy link',
                          icon: <Link2 size={14} />,
                          onSelect: () =>
                            copyPath(`${window.location.origin}/threads/${target.id}`),
                        },
                      ]),
                  {
                    label: 'Copy project path',
                    icon: <Copy size={14} />,
                    onSelect: () => copyPath(machinePath(target.cwd)),
                  },
                  {
                    label: picked.has(target.id) ? 'Unselect' : 'Select',
                    icon: <SquareCheck size={14} />,
                    onSelect: () => togglePick(target.id),
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
                const runningHere = threads.some(
                  (item) => item.cwd === path && isActive(item.status),
                )
                // "No project" isn't a real project: no renaming or avatar.
                const chats = projects.some((project) => project.path === path && project.chats)
                // A machine's project (the hub): renaming, settings, and removing happen there.
                const remote = isRemote(path)
                items = [
                  {
                    label: 'New thread here',
                    icon: <SquarePen size={14} />,
                    onSelect: () => void quickCreate(path),
                  },
                  ...(chats || remote
                    ? []
                    : [
                        {
                          label: 'Rename',
                          icon: <Pencil size={14} />,
                          onSelect: () => setRenamingProject({ path, name: projectName(path) }),
                        },
                        {
                          label: 'Project settings…',
                          icon: <Settings2 size={14} />,
                          onSelect: () => setProjectSettings(path),
                        },
                      ]),
                  {
                    label: 'Copy path',
                    icon: <Copy size={14} />,
                    onSelect: () => copyPath(machinePath(path)),
                  },
                  ...(remote
                    ? []
                    : [
                        'separator' as const,
                        {
                          label: chats ? 'Delete all chats' : 'Remove project',
                          icon: <Trash2 size={14} />,
                          danger: true,
                          disabled: runningHere || busy,
                          title: runningHere
                            ? 'Stop the running threads in this project first.'
                            : undefined,
                          onSelect: () => void removeProject(path),
                        },
                      ]),
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
        {projectSettings ? (
          <ProjectSettings
            key={projectSettings}
            path={projectSettings}
            project={projects.find((project) => project.path === projectSettings)}
            projectIcons={projectIcons}
            onClose={() => setProjectSettings(null)}
          />
        ) : null}
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
        <ThreadPreviewCard
          projectName={projectName}
          statusLabel={(status) => labels[status]}
          ago={(iso) => {
            const label = relativeTime(iso, now)
            return label === 'now' ? 'Just now' : /^\d+[mhd]$/.test(label) ? `${label} ago` : label
          }}
        />
        {paletteOpen ? (
          <CommandPalette
            threads={[...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))}
            projectName={projectName}
            status={threadStatus}
            isUnread={(item) => unread.has(item.id)}
            onOpenThread={select}
            onClose={() => setPaletteOpen(false)}
            commands={[
              {
                id: 'new-thread',
                label: 'New thread',
                shortcut: isMac ? '⇧⌘O' : 'Ctrl+Shift+O',
                run: () => openNewThread(),
              },
              {
                id: 'new-chat',
                label: 'New thread without a project',
                run: () => void quickCreate(null),
              },
              { id: 'add-project', label: 'Add project', run: () => setAddProject(true) },
              {
                id: 'sidebar',
                label: sidebarHidden ? 'Show sidebar' : 'Hide sidebar',
                shortcut: isMac ? '⌘S' : 'Ctrl+S',
                run: toggleSidebar,
              },
              { id: 'settings', label: 'Settings', run: () => setSettingsOpen(true) },
            ]}
          />
        ) : null}
        {newThreadProject !== null && bootstrap ? (
          <NewThread
            bootstrap={bootstrap}
            projects={projects}
            projectName={projectName}
            projectIcons={projectIcons}
            initialProject={newThreadProject}
            onAddProject={() => {
              setNewThreadProject(null)
              setAddProject(true)
            }}
            onClose={() => setNewThreadProject(null)}
            onCreated={(created) => {
              setNewThreadProject(null)
              // A machine's thread joins the sidebar from its machine's stream (the hub).
              if (isRemote(created.id)) threadCache.current.set(created.id, created)
              else
                setThreads((current) => [
                  { ...created, lastMessageAt: created.createdAt },
                  ...current.filter((item) => item.id !== created.id),
                ])
              select(created.id)
              revealThread(created.id)
            }}
          />
        ) : null}
        {addProject && bootstrap ? (
          <AddProject
            canBrowse={!bootstrap.remote}
            machines={machines}
            onClose={() => setAddProject(false)}
            onAdded={(project) => {
              // A machine's project joins the sidebar from its machine's stream (the hub).
              if (!project.machine)
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
    </ApiBase.Provider>
  )
}
// The New thread dialog's "No project" choice (a chat, see server/chats.ts).
const noProject = ':no-project'
function NewThread({
  bootstrap,
  projects,
  projectName,
  projectIcons,
  initialProject,
  onAddProject,
  onClose,
  onCreated,
}: {
  bootstrap: Bootstrap
  // Most recently active first.
  projects: ProjectSummary[]
  projectName: (path: string) => string
  projectIcons: boolean
  initialProject: string
  onAddProject: () => void
  onClose: () => void
  onCreated: (thread: Thread) => void
}) {
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [now] = useState(() => Date.now())
  async function create(cwd: string) {
    if (busy) return
    setBusy(cwd)
    setError('')
    try {
      // Agent, model, effort, and permissions start from your last choices; change them in the
      // composer before sending.
      const preferences = loadPreferences()
      const provider = defaultAgent(bootstrap, preferences)
      const settings = settingsFor(provider, preferences)
      // A machine's project (the hub): the thread is created on that machine.
      const remote = parseRemote(cwd)
      if (remote) {
        const machine = {
          id: remote.machine,
          name: projects.find((project) => project.path === cwd)?.machine ?? 'Machine',
        }
        const created = await api<Thread>(
          `m/${encodeURIComponent(remote.machine)}/threads`,
          'POST',
          { provider, cwd: remote.id, ...settings },
        )
        // Not remembered as your folder: that's for this computer's projects.
        rememberChoice(provider, settings)
        onCreated(hubThread(machine, created))
        return
      }
      const created = await api<Thread>('threads', 'POST', {
        provider,
        ...(cwd === noProject ? { noProject: true } : { cwd }),
        ...settings,
      })
      rememberChoice(provider, settings, created.cwd)
      onCreated(created)
    } catch (error) {
      setError((error as Error).message)
      setBusy(null)
    }
  }
  // No project (a chat in its own folder) first, always offered even before the first chat
  // makes its folder; then the project you're in, then the rest by recent activity.
  // This computer's "No project" (a machine's chats stay on that machine).
  const chatsPath = projects.find((project) => project.chats && !project.machine)?.path
  const current = chatsPath && initialProject === chatsPath ? noProject : initialProject
  const noProjectItem: ProjectSummary = {
    path: noProject,
    name: 'No project',
    chats: true,
    lastActiveAt: projects.find((project) => project.chats)?.lastActiveAt ?? '',
    addedAt: '',
    threadCount: 0,
  }
  const others = projects.filter((project) => !project.chats)
  const ordered = [
    noProjectItem,
    ...others.filter((project) => project.path === current),
    ...others.filter((project) => project.path !== current),
  ]
  const label = (project: ProjectSummary) =>
    project.path === noProject ? 'No project' : projectName(project.path)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = ordered.filter((project) => {
    const text =
      project.path === noProject
        ? 'no project chat without'
        : `${projectName(project.path)} ${project.path}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
  return (
    <Modal
      className="new-dialog new-thread-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="dialog-top">
        <ModalTitle render={<h2 />}>New thread</ModalTitle>
        <button
          className="icon-button"
          type="button"
          aria-label="Close new thread"
          disabled={Boolean(busy)}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      {/* Base UI Autocomplete, inline: type to filter, ↑/↓ to move, Enter or click to create. */}
      <Autocomplete.Root
        inline
        open
        items={shown}
        filteredItems={shown}
        // The first match is always the one Enter picks (the current project when not searching).
        autoHighlight="always"
        value={query}
        onValueChange={(value, details) => {
          if (details.reason !== 'item-press') setQuery(value)
        }}
        itemToStringValue={(project: ProjectSummary) => label(project)}
      >
        <label className="palette-search project-search">
          <Search size={15} aria-hidden />
          <Autocomplete.Input
            className="palette-input"
            placeholder="Search projects…"
            autoFocus
            maxLength={200}
            disabled={Boolean(busy)}
          />
        </label>
        <Autocomplete.Empty className="palette-empty">
          {query ? 'No project matches.' : 'No projects yet.'}
        </Autocomplete.Empty>
        <Autocomplete.List className="palette-list project-list">
          {(project: ProjectSummary) => (
            <Autocomplete.Item
              key={project.path}
              value={project}
              className="palette-item project-item"
              onClick={() => void create(project.path)}
              disabled={Boolean(busy)}
            >
              <span className="project-item-icon">
                {projectIcons || project.chats ? (
                  <ProjectAvatar path={project.path} name={label(project)} project={project} />
                ) : (
                  <Folder size={15} />
                )}
              </span>
              <span className="palette-text">
                <span className="palette-label">
                  {label(project)}
                  {project.machine ? <MachineTag name={project.machine} /> : null}
                </span>
                <span className="palette-detail" title={machinePath(project.path)}>
                  {project.path === noProject
                    ? 'A chat with its own folder, outside your projects'
                    : machinePath(project.path)}
                </span>
              </span>
              <span className="palette-hint">
                {busy === project.path ? (
                  <LoaderCircle size={13} className="status-spinner" aria-label="Creating" />
                ) : project.path === current ? (
                  'Current'
                ) : project.lastActiveAt ? (
                  relativeTime(project.lastActiveAt, now)
                ) : null}
              </span>
            </Autocomplete.Item>
          )}
        </Autocomplete.List>
      </Autocomplete.Root>
      {error ? (
        <div className="error-banner new-thread-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="new-thread-footer">
        <button type="button" className="secondary" onClick={onAddProject} disabled={Boolean(busy)}>
          <FolderPlus size={14} />
          Add project…
        </button>
        <span className="new-thread-keys">↑↓ to move · Enter to start</span>
      </div>
    </Modal>
  )
}
function AddProject({
  canBrowse,
  machines,
  onClose,
  onAdded,
}: {
  // The folder chooser opens on the Mac, so a paired phone types the path instead.
  canBrowse: boolean
  // Online machines (the hub): the project can be added on one of them instead.
  machines: HubMachine[]
  onClose: () => void
  onAdded: (project: ProjectSummary) => void
}) {
  // Always starts at the home folder of the computer it's added on (this Mac or a machine).
  const [path, setPath] = useState('~/')
  const [error, setError] = useState('')
  // The folder doesn't exist yet: offer to create it (inside the home folder only).
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  // Where the project goes: this computer ('') or a machine's id.
  const [machineId, setMachineId] = useState('')
  const machine = machines.find((item) => item.id === machineId)
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
  async function add(event?: FormEvent, create = false) {
    event?.preventDefault()
    if (busy || picking) return
    setBusy(true)
    setError('')
    setMissing(false)
    try {
      const body = { path, ...(create ? { create: true } : {}) }
      onAdded(
        machine
          ? hubProject(
              machine,
              await api<ProjectSummary>(
                `m/${encodeURIComponent(machine.id)}/projects`,
                'POST',
                body,
              ),
            )
          : await api<ProjectSummary>('projects', 'POST', body),
      )
    } catch (error) {
      const message = (error as Error).message
      setError(message)
      setMissing(!create && /does not exist/.test(message))
      setBusy(false)
    }
  }
  function choose(id: string) {
    setMachineId(id)
    setError('')
    setMissing(false)
    setPath('~/')
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
        {machines.length ? (
          <div className="field">
            <span className="field-label">On</span>
            <Segmented
              label="Machine"
              value={machineId}
              onChange={choose}
              options={[
                { value: '', label: 'This Mac' },
                ...machines.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          </div>
        ) : null}
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
            {canBrowse && !machine ? (
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
              : machine
                ? `An absolute path or ~/… on ${machine.name}. Agents there can edit files in this folder.`
                : 'An absolute path or ~/… on this machine. Agents can edit files in this folder.'}
          </small>
        </div>
        {error ? (
          <div className="error-banner" role="alert">
            {error}
            {missing ? (
              <button
                className="secondary add-project-create"
                type="button"
                disabled={busy}
                onClick={() => void add(undefined, true)}
              >
                <FolderPlus size={14} />
                Create it and add
              </button>
            ) : null}
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
