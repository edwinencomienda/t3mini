import { useEffect, useRef, useState } from 'react'
import {
  Bell,
  CircleAlert,
  CircleCheck,
  CircleStop,
  Monitor,
  Moon,
  ShieldAlert,
  Sun,
  X,
} from 'lucide-react'
import { themeLabels, themes, type Theme } from '../theme'
import type { Bootstrap } from '../types'
import { playSound, sounds } from '../sound'
import { PhoneAccess } from './PhoneAccess'
import {
  desktopPermission,
  eventText,
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
const folderName = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) || '/'

function Toast({
  event,
  onOpen,
  onDismiss,
}: {
  event: ThreadEvent
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
        <span className="toast-icon">{icons[event.kind]}</span>
        <span className="toast-text">
          <strong>{event.thread.title}</strong>
          <small>
            {eventText[event.kind]} · {folderName(event.thread.cwd)}
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
  onOpen,
  onDismiss,
}: {
  events: ThreadEvent[]
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

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function SettingsDialog({
  preferences,
  providers,
  theme,
  onThemeChange,
  onChange,
  onClose,
  remote = false,
  onPhoneAccessChange,
}: {
  preferences: NotificationPreferences
  providers?: Bootstrap['providers']
  remote?: boolean
  onPhoneAccessChange?: (enabled: boolean) => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onChange: (preferences: NotificationPreferences) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [permission, setPermission] = useState<DesktopPermission>(desktopPermission)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  async function setDesktop(enabled: boolean) {
    if (!enabled) return onChange({ ...preferences, desktop: false, prompted: true })
    const result = permission === 'granted' ? 'granted' : await requestDesktopPermission()
    setPermission(result)
    onChange({ ...preferences, desktop: result === 'granted', prompted: true })
  }
  const desktopOn = preferences.desktop && permission === 'granted'
  return (
    <dialog
      ref={dialog}
      className="new-dialog settings-dialog"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === dialog.current) onClose()
      }}
    >
      <div className="settings-body">
        <div className="dialog-top">
          <h2>Settings</h2>
          <button className="icon-button" aria-label="Close settings" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <section className="settings-section">
          <h3>Appearance</h3>
          <div className="setting-row">
            <div>
              <strong>Theme</strong>
              <small>System follows your computer’s light or dark setting.</small>
            </div>
            <div className="segmented" role="radiogroup" aria-label="Theme">
              {themes.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={theme === item}
                  onClick={() => onThemeChange(item)}
                >
                  {item === 'light' ? (
                    <Sun size={12} />
                  ) : item === 'dark' ? (
                    <Moon size={12} />
                  ) : (
                    <Monitor size={12} />
                  )}
                  {themeLabels[item]}
                </button>
              ))}
            </div>
          </div>
        </section>
        {/* Phone access is managed only from the Mac itself. */}
        {!remote ? <PhoneAccess onChange={(enabled) => onPhoneAccessChange?.(enabled)} /> : null}
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
                </div>
                <span
                  className={`cli-status ${health?.installed ? 'ok' : health ? 'missing' : ''}`}
                >
                  {!health ? '…' : health.installed ? 'Installed' : 'Not found'}
                </span>
              </div>
            )
          })}
        </section>
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
              <div className="segmented" role="radiogroup" aria-label="Sound style">
                {sounds.map((sound) => (
                  <button
                    key={sound.value}
                    type="button"
                    role="radio"
                    aria-checked={preferences.soundName === sound.value}
                    onClick={() => {
                      playSound(sound.value)
                      onChange({ ...preferences, soundName: sound.value })
                    }}
                  >
                    {sound.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </dialog>
  )
}
