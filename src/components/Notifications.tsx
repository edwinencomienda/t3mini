import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Bell,
  Bot,
  Mic,
  Music,
  Palette,
  Smartphone,
  CircleAlert,
  CircleCheck,
  CircleStop,
  Monitor,
  Moon,
  ShieldAlert,
  Sun,
  Eye,
  EyeOff,
  MessageCircleQuestion,
  X,
} from 'lucide-react'
import { themeLabels, themes, type Theme } from '../theme'
import { saveMascots, useMascotSetting } from '../mascots'
import { saveProjectIcons, useProjectIcons } from './ProjectAvatar'
import { Input } from '@base-ui/react/input'
import { Slider } from '@base-ui/react/slider'
import type { BrowserStatsData } from '../server/browser-stats'
import { parseYouTube, saveMusic, useMusicSettings } from '../background-music'
import type { Bootstrap } from '../types'
import { playSound, sounds } from '../sound'
import { PhoneAccess } from './PhoneAccess'
import { Modal, ModalTitle } from './Modal'
import { Segmented, Toggle } from './ui'
import { Tabs } from '@base-ui/react/tabs'
import { DictationSettings } from './DictationSettings'
import {
  desktopPermission,
  eventLabel,
  requestDesktopPermission,
  type DesktopPermission,
  type NotificationPreferences,
  type ThreadEvent,
} from '../notifications'

const icons = {
  completed: <CircleCheck size={16} />,
  failed: <CircleAlert size={16} />,
  interrupted: <CircleStop size={16} />,
  waiting: <ShieldAlert size={16} />,
}

const agentNames = { claude: 'Claude', codex: 'Codex' } as const

function Toast({
  event,
  project,
  onOpen,
  onDismiss,
}: {
  event: ThreadEvent
  // The project's sidebar name (its custom name, else its folder).
  project: string
  onOpen: () => void
  onDismiss: () => void
}) {
  const [paused, setPaused] = useState(false)
  // Live updates re-render often; keep the timer from restarting on every new callback.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    // Approvals block the agent, so they stay until handled or dismissed.
    if (paused || event.kind === 'waiting') return
    const timer = setTimeout(() => dismiss.current(), 8000)
    return () => clearTimeout(timer)
  }, [paused, event.kind])
  return (
    <div
      className={`toast ${event.kind}`}
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <button className="toast-body" onClick={onOpen}>
        <span className="toast-icon">
          {event.kind === 'waiting' && event.thread.waitingFor === 'question' ? (
            <MessageCircleQuestion size={16} />
          ) : (
            icons[event.kind]
          )}
        </span>
        <span className="toast-text">
          <strong>{event.thread.title}</strong>
          <small>
            {project} · {agentNames[event.thread.provider]} {eventLabel(event).toLowerCase()}
          </small>
        </span>
      </button>
      <button className="icon-button" aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  )
}

export function Toasts({
  events,
  projectName,
  onOpen,
  onDismiss,
}: {
  events: ThreadEvent[]
  projectName: (path: string) => string
  onOpen: (event: ThreadEvent) => void
  onDismiss: (key: string) => void
}) {
  if (!events.length) return null
  return (
    <div className="toasts" aria-live="polite">
      {events.slice(-4).map((event) => (
        <Toast
          key={event.key}
          event={event}
          project={projectName(event.thread.cwd)}
          onOpen={() => onOpen(event)}
          onDismiss={() => onDismiss(event.key)}
        />
      ))}
    </div>
  )
}

// First-visit invitation. The browser prompt opens only after the user clicks Enable.
export function NotificationPrompt({
  onEnable,
  onDismiss,
}: {
  onEnable: () => void
  onDismiss: () => void
}) {
  return (
    <div className="notify-prompt" role="dialog" aria-label="Enable desktop notifications">
      <Bell size={16} />
      <div>
        <strong>Get notified when a thread finishes</strong>
        <small>
          Desktop alerts when an agent is done or needs approval. Change this in Settings.
        </small>
      </div>
      <div className="notify-prompt-actions">
        <button className="secondary" onClick={onDismiss}>
          Not now
        </button>
        <button className="primary" onClick={onEnable}>
          Enable
        </button>
      </div>
    </div>
  )
}

// "Signed in · Claude Team" (or with the email when it's shown), or how to sign in.
type ProviderAccount = { signedIn: boolean; email?: string; plan?: string; error?: string }
function accountLine(
  provider: 'claude' | 'codex',
  account: ProviderAccount | undefined,
  showEmail: boolean,
) {
  if (!account) return 'Checking account…'
  if (account.error) return account.error
  if (!account.signedIn)
    return `Not signed in. Run ${provider === 'claude' ? '`claude`' : '`codex login`'} in a terminal.`
  return [account.email && showEmail ? `Signed in as ${account.email}` : 'Signed in', account.plan]
    .filter(Boolean)
    .join(' · ')
}

// Settings is split into tabs so each page stays short. The last tab is remembered while the
// page is open; Mac-only tabs are hidden on a paired phone.
type SettingsTab = 'appearance' | 'notifications' | 'music' | 'dictation' | 'phone' | 'agents'
const settingsTabs: { id: SettingsTab; label: string; icon: ReactNode; macOnly?: boolean }[] = [
  { id: 'appearance', label: 'Appearance', icon: <Palette size={14} /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell size={14} /> },
  { id: 'music', label: 'Music', icon: <Music size={14} /> },
  { id: 'dictation', label: 'Dictation', icon: <Mic size={14} />, macOnly: true },
  { id: 'phone', label: 'Phone access', icon: <Smartphone size={14} />, macOnly: true },
  { id: 'agents', label: 'Agents', icon: <Bot size={14} /> },
]
let lastTab: SettingsTab = 'appearance'

export function SettingsDialog({
  preferences,
  providers,
  theme,
  onThemeChange,
  onChange,
  onClose,
  remote = false,
  onPhoneAccessChange,
  onDictationChange,
}: {
  preferences: NotificationPreferences
  providers?: Bootstrap['providers']
  remote?: boolean
  onPhoneAccessChange?: (enabled: boolean) => void
  onDictationChange?: (configured: boolean) => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onChange: (preferences: NotificationPreferences) => void
  onClose: () => void
}) {
  const [permission, setPermission] = useState<DesktopPermission>(desktopPermission)
  const mascotsOn = useMascotSetting()
  const projectIconsOn = useProjectIcons()
  const music = useMusicSettings()
  // The link as typed, saved once it's a YouTube link (or cleared).
  const [musicUrl, setMusicUrl] = useState('')
  useEffect(() => setMusicUrl(music.url), [music.url])
  const musicValid = !musicUrl.trim() || Boolean(parseYouTube(musicUrl))
  // Account emails are hidden until you choose to show them (not remembered).
  const [showEmails, setShowEmails] = useState(false)
  // Who each agent is signed in as; loaded when the Agents tab opens.
  const [accounts, setAccounts] = useState<Record<'claude' | 'codex', ProviderAccount> | null>(null)
  // How often each agent checked UI changes in the browser; loaded with the Agents tab.
  const [browserStats, setBrowserStats] = useState<BrowserStatsData | null>(null)
  async function setDesktop(enabled: boolean) {
    if (!enabled) return onChange({ ...preferences, desktop: false, prompted: true })
    const result = permission === 'granted' ? 'granted' : await requestDesktopPermission()
    setPermission(result)
    onChange({ ...preferences, desktop: result === 'granted', prompted: true })
  }
  const desktopOn = preferences.desktop && permission === 'granted'
  const [tab, setTab] = useState<SettingsTab>(() =>
    remote && (lastTab === 'dictation' || lastTab === 'phone') ? 'appearance' : lastTab,
  )
  const selectTab = (next: SettingsTab) => {
    lastTab = next
    setTab(next)
  }
  useEffect(() => {
    if (tab !== 'agents') return
    fetch('/api/browser-stats')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setBrowserStats(data))
      .catch(() => {})
  }, [tab])
  useEffect(() => {
    if (tab !== 'agents' || accounts) return
    fetch('/api/providers/accounts')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setAccounts(data))
      .catch(() => {})
  }, [tab, accounts])
  return (
    <Modal className="new-dialog settings-dialog" onClose={onClose}>
      <div className="settings-body">
        <div className="dialog-top">
          <ModalTitle render={<h2 />}>Settings</ModalTitle>
          <button className="icon-button" aria-label="Close settings" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <Tabs.Root
          className="settings-layout"
          orientation="vertical"
          value={tab}
          onValueChange={(next: SettingsTab) => selectTab(next)}
        >
          <Tabs.List className="settings-tabs" aria-label="Settings" activateOnFocus>
            {settingsTabs
              .filter((item) => !(remote && item.macOnly))
              .map((item) => (
                <Tabs.Tab key={item.id} value={item.id}>
                  {item.icon}
                  {item.label}
                </Tabs.Tab>
              ))}
          </Tabs.List>
          <Tabs.Panel className="settings-panel" value={tab}>
            {tab === 'appearance' ? (
              <section className="settings-section">
                <h3>Appearance</h3>
                <div className="setting-row">
                  <div>
                    <strong>Theme</strong>
                    <small>System follows your computer’s light or dark setting.</small>
                  </div>
                  <Segmented
                    label="Theme"
                    value={theme}
                    onChange={onThemeChange}
                    options={themes.map((item) => ({
                      value: item,
                      label: (
                        <>
                          {item === 'light' ? (
                            <Sun size={12} />
                          ) : item === 'dark' ? (
                            <Moon size={12} />
                          ) : (
                            <Monitor size={12} />
                          )}
                          {themeLabels[item]}
                        </>
                      ),
                    }))}
                  />
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Working animations</strong>
                    <small>
                      Show the Claude and Codex characters while an agent works. Off shows the
                      simple dots.
                    </small>
                  </div>
                  <Toggle
                    label="Working animations"
                    checked={mascotsOn}
                    onChange={(enabled) => saveMascots(enabled)}
                  />
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Project icons</strong>
                    <small>
                      Show each project’s own icon, or its first letter, in the sidebar. Off shows
                      folder icons.
                    </small>
                  </div>
                  <Toggle
                    label="Project icons"
                    checked={projectIconsOn}
                    onChange={(enabled) => saveProjectIcons(enabled)}
                  />
                </div>
              </section>
            ) : null}
            {tab === 'music' ? (
              <section className="settings-section">
                <h3>Music</h3>
                <div className="setting-row">
                  <div>
                    <strong>Working background music</strong>
                    <small>
                      Plays a YouTube video or playlist (lofi, anyone?) while any agent is working,
                      and fades out when they’re done. One song at a time, in the tab you used last.
                    </small>
                  </div>
                  <Toggle
                    label="Working background music"
                    checked={music.enabled}
                    onChange={(enabled) => saveMusic({ enabled })}
                  />
                </div>
                {music.enabled ? (
                  <div className="setting-row music-settings">
                    <label className="music-field">
                      <span>YouTube link</span>
                      <Input
                        className="music-url"
                        placeholder="https://www.youtube.com/watch?v=…"
                        value={musicUrl}
                        maxLength={500}
                        spellCheck={false}
                        onValueChange={(value: string) => {
                          setMusicUrl(value)
                          if (!value.trim() || parseYouTube(value)) saveMusic({ url: value.trim() })
                        }}
                      />
                      {!musicValid ? (
                        <small className="music-invalid">
                          That isn’t a YouTube video or playlist link.
                        </small>
                      ) : null}
                    </label>
                    <div className="music-field">
                      <span>Volume · {music.volume}%</span>
                      <Slider.Root
                        className="music-volume"
                        value={music.volume}
                        min={0}
                        max={100}
                        step={5}
                        onValueChange={(value) =>
                          saveMusic({ volume: Array.isArray(value) ? value[0]! : value })
                        }
                      >
                        <Slider.Control className="music-volume-control">
                          <Slider.Track className="music-volume-track">
                            <Slider.Indicator className="music-volume-indicator" />
                            <Slider.Thumb className="music-volume-thumb" aria-label="Volume" />
                          </Slider.Track>
                        </Slider.Control>
                      </Slider.Root>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}
            {tab === 'notifications' ? (
              <section className="settings-section">
                <h3>Notifications</h3>
                <div className="setting-row">
                  <div>
                    <strong>Desktop notifications</strong>
                    <small>
                      {permission === 'unsupported'
                        ? 'This browser does not support desktop notifications.'
                        : permission === 'denied'
                          ? 'Blocked by your browser. Allow notifications for this site in your browser’s site settings, then reload.'
                          : 'Alert me when a thread finishes or needs approval while this window is in the background.'}
                    </small>
                  </div>
                  <Toggle
                    label="Desktop notifications"
                    checked={desktopOn}
                    disabled={permission === 'unsupported' || permission === 'denied'}
                    onChange={(enabled) => void setDesktop(enabled)}
                  />
                </div>
                <div className="setting-row">
                  <div>
                    <strong>In-app notifications</strong>
                    <small>Show a toast for finished threads. Click one to open the thread.</small>
                  </div>
                  <Toggle
                    label="In-app notifications"
                    checked={preferences.inApp}
                    onChange={(inApp) => onChange({ ...preferences, inApp })}
                  />
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Sound</strong>
                    <small>Play a sound when a thread finishes.</small>
                  </div>
                  <Toggle
                    label="Sound"
                    checked={preferences.sound}
                    onChange={(sound) => {
                      if (sound) playSound(preferences.soundName)
                      onChange({ ...preferences, sound })
                    }}
                  />
                </div>
                {preferences.sound ? (
                  <div className="setting-row sound-choice">
                    <div>
                      <strong>Sound style</strong>
                      <small>Click one to hear it.</small>
                    </div>
                    <Segmented
                      label="Sound style"
                      value={preferences.soundName}
                      options={sounds}
                      onChange={(soundName) => onChange({ ...preferences, soundName })}
                      onOptionClick={playSound}
                    />
                  </div>
                ) : null}
              </section>
            ) : null}
            {/* Dictation and phone access are managed only on the Mac. */}
            {tab === 'dictation' && !remote ? (
              <DictationSettings onChange={(configured) => onDictationChange?.(configured)} />
            ) : null}
            {tab === 'phone' && !remote ? (
              <PhoneAccess onChange={(enabled) => onPhoneAccessChange?.(enabled)} />
            ) : null}
            {tab === 'agents' ? (
              <section className="settings-section">
                <h3>Agents</h3>
                {(['claude', 'codex'] as const).map((provider) => {
                  const health = providers?.[provider]
                  return (
                    <div className="setting-row" key={provider}>
                      <div>
                        <strong>{provider === 'claude' ? 'Claude Code' : 'Codex'}</strong>
                        <small>
                          {!health
                            ? 'Checking…'
                            : health.installed
                              ? health.version || 'CLI installed'
                              : `Install the ${provider} CLI and sign in, then restart the server.`}
                        </small>
                        {health?.installed ? (
                          <small className="agent-account">
                            <span>{accountLine(provider, accounts?.[provider], showEmails)}</span>
                            {/* Emails stay hidden until asked for (e.g. while screen sharing). */}
                            {accounts?.[provider]?.email ? (
                              <button
                                type="button"
                                className="icon-button agent-email-toggle"
                                aria-label={showEmails ? 'Hide email' : 'Show email'}
                                aria-pressed={showEmails}
                                title={showEmails ? 'Hide email' : 'Show email'}
                                onClick={() => setShowEmails((value) => !value)}
                              >
                                {showEmails ? <EyeOff size={13} /> : <Eye size={13} />}
                              </button>
                            ) : null}
                          </small>
                        ) : null}
                      </div>
                      <span
                        className={`cli-status ${health?.installed ? 'ok' : health ? 'missing' : ''}`}
                      >
                        {!health ? '…' : health.installed ? 'Installed' : 'Not found'}
                      </span>
                    </div>
                  )
                })}
                {browserStats ? (
                  <div className="setting-row">
                    <div>
                      <strong>Browser checks</strong>
                      <small>
                        Of the finished turns that changed UI files (components, pages, styles), how
                        many also looked at the result in the browser. Since{' '}
                        {new Date(browserStats.since).toLocaleDateString()}.
                      </small>
                      <small className="browser-stats">
                        {(['claude', 'codex'] as const).map((provider) => {
                          const { uiTurns, checked } = browserStats[provider]
                          return (
                            <span key={provider}>
                              {provider === 'claude' ? 'Claude' : 'Codex'}:{' '}
                              {uiTurns
                                ? `${checked} of ${uiTurns} (${Math.round((checked / uiTurns) * 100)}%)`
                                : 'no UI changes yet'}
                            </span>
                          )
                        })}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void fetch('/api/browser-stats/reset', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: '{}',
                        })
                          .then((response) => (response.ok ? response.json() : null))
                          .then((data) => data && setBrowserStats(data))
                          .catch(() => {})
                      }
                    >
                      Reset
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </Tabs.Panel>
        </Tabs.Root>
      </div>
    </Modal>
  )
}
