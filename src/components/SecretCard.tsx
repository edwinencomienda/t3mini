import { useState } from 'react'
import { Field } from '@base-ui/react/field'
import { Input } from '@base-ui/react/input'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import type { Approval } from '../types'

// request_secret: the agent needs an API key, token, or password. You type it here and it goes
// straight to the project's env file on your computer (POST /api/threads/:id/secret); the agent
// only learns that it was saved, and where. The value lives in this field's state until it's
// sent, then is cleared: it's never saved in the browser, a draft, or the thread.

export function SecretCard({
  approval,
  disabled,
  onSave,
  onSkip,
}: {
  approval: Approval & { secret: NonNullable<Approval['secret']> }
  disabled: boolean
  onSave: (value: string) => Promise<boolean>
  onSkip: () => void
}) {
  const { name, reason, file } = approval.secret
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [saving, setSaving] = useState(false)
  const busy = disabled || saving

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!value || busy) return
    setSaving(true)
    const ok = await onSave(value)
    setSaving(false)
    // Gone from the page once it's saved (on failure it stays, to fix and retry).
    if (ok) setValue('')
  }

  return (
    <form className="secret-card" onSubmit={save} autoComplete="off">
      <div className="secret-head">
        <KeyRound size={16} className="secret-icon" />
        <div>
          <strong>
            The agent needs <code>{name}</code>
          </strong>
          <p>{reason}</p>
        </div>
      </div>
      <Field.Root className="secret-field">
        <Field.Label className="sr-only">{name}</Field.Label>
        <div className="secret-input">
          <Input
            type={shown ? 'text' : 'password'}
            value={value}
            onValueChange={setValue}
            placeholder="Paste it here"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
          <button
            type="button"
            className="secret-reveal"
            onClick={() => setShown(!shown)}
            aria-label={shown ? 'Hide' : 'Show'}
            disabled={busy}
          >
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <Field.Description className="secret-note">
          Saved to <code>{file}</code> on your computer. The agent never sees it, and it isn't kept
          in this chat.
        </Field.Description>
      </Field.Root>
      <div className="approval-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onSkip}>
          Skip
        </button>
        <button type="submit" className="primary" disabled={busy || !value}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
