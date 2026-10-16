import { useRef, useState, type ReactNode } from 'react'
import { AlertDialog } from '@base-ui/react/alert-dialog'

// Confirmations, styled like the rest of the app (instead of the browser's confirm()). Built
// on Base UI's AlertDialog: announced as an alert, closes only through its buttons or Esc, and
// starts on Cancel so an accidental Enter never confirms something destructive.
//
//   const [confirmDialog, confirm] = useConfirm()
//   if (!(await confirm({ title: 'Delete this thread?', confirmLabel: 'Delete', danger: true })))
//     return
//   …render {confirmDialog} somewhere in the component.

export type ConfirmOptions = {
  title: string
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  // Red confirm button, for actions that remove something.
  danger?: boolean
}

export function useConfirm() {
  const [request, setRequest] = useState<
    (ConfirmOptions & { resolve: (confirmed: boolean) => void }) | null
  >(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const finish = (confirmed: boolean) => {
    request?.resolve(confirmed)
    setRequest(null)
  }
  const confirm = (options: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      // A second request replaces (and cancels) one still open.
      setRequest((current) => {
        current?.resolve(false)
        return { ...options, resolve }
      })
    })
  const dialog = (
    <AlertDialog.Root
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open) finish(false)
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" />
        <AlertDialog.Popup className="new-dialog confirm-dialog" initialFocus={cancel}>
          <AlertDialog.Title className="confirm-title">{request?.title}</AlertDialog.Title>
          {request?.description ? (
            <AlertDialog.Description className="confirm-description">
              {request.description}
            </AlertDialog.Description>
          ) : null}
          <div className="dialog-actions">
            <button ref={cancel} type="button" className="secondary" onClick={() => finish(false)}>
              {request?.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              className={request?.danger ? 'danger-button' : 'primary'}
              onClick={() => finish(true)}
            >
              {request?.confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
  return [dialog, confirm] as const
}
