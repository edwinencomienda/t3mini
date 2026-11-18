import { useEffect, useState } from 'react'
import { disablePush, enablePush, pushState, testPush, type PushState } from '../push'
import { Toggle } from './ui'

// Settings → Notifications → Push notifications: notifications on this device even with t3 mini
// closed (src/push.ts). On iPhone they need t3 mini on the home screen, so that's explained here.
const help: Record<PushState, string> = {
  unsupported: 'This browser can’t receive push notifications here.',
  install:
    'On iPhone, open this page in Safari, tap Share → Add to Home Screen, then open t3 mini from your home screen and turn this on there.',
  denied:
    'Notifications are blocked for t3 mini. Allow them in your device’s settings for this site or app, then come back.',
  off: 'Get a notification on this device when a thread finishes, fails, or needs you, even with t3 mini closed.',
  on: 'On for this device: you’ll be notified when a thread finishes, fails, or needs you.',
}

export function PushSetting() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let live = true
    void pushState().then((value) => live && setState(value))
    return () => {
      live = false
    }
  }, [])

  // Straight from the tap: iPhone only shows the permission prompt in response to one.
  const change = async (enabled: boolean) => {
    setBusy(true)
    setMessage('')
    try {
      setState(enabled ? await enablePush() : await disablePush())
    } catch (error) {
      setMessage((error as Error).message || 'Couldn’t change notifications.')
      setState(await pushState())
    } finally {
      setBusy(false)
    }
  }
  const test = async () => {
    setBusy(true)
    setMessage('')
    try {
      await testPush()
      setMessage('Sent. It should appear in a few seconds.')
    } catch (error) {
      setMessage((error as Error).message || 'Couldn’t send a test.')
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null
  return (
    <div className="setting-row">
      <div>
        <strong>Push notifications on this device</strong>
        <small>{help[state]}</small>
        {state === 'on' ? (
          <small>
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => void test()}
            >
              Send a test
            </button>
          </small>
        ) : null}
        {message ? <small role="status">{message}</small> : null}
      </div>
      <Toggle
        label="Push notifications on this device"
        checked={state === 'on'}
        disabled={busy || state === 'unsupported' || state === 'install' || state === 'denied'}
        onChange={(enabled) => void change(enabled)}
      />
    </div>
  )
}
