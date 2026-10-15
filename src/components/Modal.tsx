import type { ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'

// Every modal in t3 mini, built on Base UI's Dialog: it traps focus, closes on Escape or a click
// outside, and puts focus back where it was. It's open while mounted; onClose can decline (keep
// it open) while something is still saving.
export function Modal({
  className,
  backdropClassName = 'dialog-backdrop',
  label,
  onClose,
  onClick,
  children,
}: {
  className: string
  backdropClassName?: string
  // For dialogs without a visible title; otherwise their <h2> is the Dialog.Title.
  label?: string
  onClose: () => void
  onClick?: React.MouseEventHandler<HTMLDivElement>
  children: ReactNode
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClassName} />
        <Dialog.Popup className={className} aria-label={label} onClick={onClick}>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
export const ModalTitle = Dialog.Title
