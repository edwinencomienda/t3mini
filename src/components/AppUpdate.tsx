import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useConfirm } from './ConfirmDialog'

// A newer t3mini installed while this one runs (server/app-update.ts), shown at the bottom of
// the sidebar on the Mac (never on a phone, and never in dev). Restart switches to it: right
// away, or once every agent is done, since restarting stops turns that are running. The page
// reloads itself when the new server answers.

type Update = { ready: boolean; commit?: string; whenIdle: boolean }

async function request(method = 'GET', body?: unknown): Promise<Update> {
  const response = await fetch(`/api/app-update${method === 'GET' ? '' : '/restart'}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data as Update
}

export function AppUpdate({ enabled, running }: { enabled: boolean; running: number }) {
  const [update, setUpdate] = useState<Update | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState('')
  const [hidden, setHidden] = useState(false)
  const [confirmDialog, confirm] = useConfirm()
  // Waiting for a restart (now, or when idle): an answer without an update means the new one is up.
  const waiting = restarting || Boolean(update?.whenIdle)
  const waitingRef = useRef(waiting)
  waitingRef.current = waiting
  const restartingRef = useRef(restarting)
  restartingRef.current = restarting

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const since = Date.now()
    const check = () =>
      request()
        .then((next) => {
          if (cancelled) return
          if (waitingRef.current && !next.ready) return window.location.reload()
          setUpdate(next)
        })
        .catch(() => {
          // Down while it restarts; given up after a minute.
          if (cancelled || !restartingRef.current) return
          if (Date.now() - since > 60_000) {
            setRestarting(false)
            setError('The restart didn’t finish. Run `t3mini restart` in a terminal.')
          }
        })
    void check()
    // Checking is a file stat on the server: cheap, but only often while a restart is coming.
    const timer = setInterval(check, waiting ? 1500 : 30_000)
    window.addEventListener('focus', check)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', check)
    }
  }, [enabled, waiting, restarting])

  async function restart(when: 'now' | 'idle' | 'cancel') {
    setError('')
    if (when === 'now' && running) {
      const ok = await confirm({
        title: 'Restart t3 mini now?',
        description: `${running === 1 ? 'An agent is' : `${running} agents are`} still working. Restarting stops ${running === 1 ? 'its turn' : 'their turns'}; you can send the message again afterwards.`,
        confirmLabel: 'Restart now',
        danger: true,
      })
      if (!ok) return
    }
    try {
      if (when === 'now') setRestarting(true)
      setUpdate(await request('POST', { when }))
    } catch (failure) {
      setRestarting(false)
      setError(failure instanceof Error ? failure.message : 'Restart failed.')
    }
  }

  if (!enabled || !update?.ready || (hidden && !waiting)) return confirmDialog
  const status = restarting
    ? 'Restarting…'
    : update.whenIdle
      ? 'Restarts when the agents finish'
      : running
        ? `${running === 1 ? 'An agent is' : `${running} agents are`} working`
        : 'Restart to use it'
  return (
    <section className="provider-updates app-update" aria-label="t3 mini update">
      <div className="provider-updates-head">
        <strong>t3 mini update installed</strong>
        {!waiting ? (
          <button
            className="icon-button"
            aria-label="Hide update"
            title="Hide"
            onClick={() => setHidden(true)}
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
      <div className="provider-update">
        <RefreshCw size={14} aria-hidden />
        <div className="provider-update-text">
          <span>{update.commit ? `Built from ${update.commit}` : 'A newer version'}</span>
          <small className={error ? 'error' : undefined}>{error || status}</small>
        </div>
      </div>
      <div className="app-update-actions">
        {restarting ? (
          <button className="secondary" disabled>
            <LoaderCircle size={13} className="status-spinner" />
            Restarting
          </button>
        ) : update.whenIdle ? (
          <>
            <button className="secondary" onClick={() => void restart('cancel')}>
              Cancel
            </button>
            <button className="secondary" onClick={() => void restart('now')}>
              Restart now
            </button>
          </>
        ) : running ? (
          <>
            <button className="secondary" onClick={() => void restart('idle')}>
              When done
            </button>
            <button className="secondary" onClick={() => void restart('now')}>
              Restart now
            </button>
          </>
        ) : (
          <button className="secondary" onClick={() => void restart('now')}>
            Restart
          </button>
        )}
      </div>
      {confirmDialog}
    </section>
  )
}
