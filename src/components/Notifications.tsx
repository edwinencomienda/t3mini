import { useEffect, useRef, useState } from 'react'
import { Bell, CircleAlert, CircleCheck, CircleStop, ShieldAlert, X } from 'lucide-react'
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
  onChange,
  onClose,
}: {
  preferences: NotificationPreferences
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
        </section>
      </div>
    </dialog>
  )
}
