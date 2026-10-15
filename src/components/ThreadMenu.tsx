import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, Pencil, Trash2 } from 'lucide-react'

export type ThreadMenuState = { id: string; x: number; y: number }

// Right-click menu for a sidebar thread, positioned at the pointer and kept inside the viewport.
export function ThreadMenu({
  menu,
  canDelete,
  onRename,
  onCopyPath,
  onDelete,
  onClose,
}: {
  menu: ThreadMenuState
  canDelete: boolean
  onRename: () => void
  onCopyPath: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: menu.x, top: menu.y })
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)),
    })
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])
  useEffect(() => {
    const close = (event: Event) => {
      if (!(event.target instanceof Node && root.current?.contains(event.target))) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('scroll', close, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  function move(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
    ]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    items[(index + step + items.length) % items.length]?.focus()
  }
  const run = (action: () => void) => () => {
    onClose()
    action()
  }
  return (
    <div
      ref={root}
      className="context-menu"
      role="menu"
      aria-label="Thread actions"
      style={position}
      onKeyDown={move}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button role="menuitem" onClick={run(onRename)}>
        <Pencil size={14} />
        Rename
      </button>
      <button role="menuitem" onClick={run(onCopyPath)}>
        <Copy size={14} />
        Copy project path
      </button>
      <div className="context-menu-separator" role="separator" />
      <button
        role="menuitem"
        className="danger"
        disabled={!canDelete}
        title={canDelete ? undefined : 'Stop the agent before deleting this thread.'}
        onClick={run(onDelete)}
      >
        <Trash2 size={14} />
        Delete
      </button>
    </div>
  )
}
