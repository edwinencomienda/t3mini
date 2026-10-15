import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type MenuPosition = { x: number; y: number }
export type MenuItem =
  | {
      label: string
      icon: ReactNode
      onSelect: () => void
      danger?: boolean
      disabled?: boolean
      title?: string
    }
  | 'separator'

// Right-click menu, positioned at the pointer and kept inside the viewport.
export function ContextMenu({
  position,
  label,
  items,
  onClose,
}: {
  position: MenuPosition
  label: string
  items: MenuItem[]
  onClose: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState({ left: position.x, top: position.y })
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    setStyle({
      left: Math.max(8, Math.min(position.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(position.y, window.innerHeight - height - 8)),
    })
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [position])
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
    const buttons = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
    ]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    buttons[(index + step + buttons.length) % buttons.length]?.focus()
  }
  return (
    <div
      ref={root}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={style}
      onKeyDown={move}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === 'separator' ? (
          <div className="context-menu-separator" role="separator" key={index} />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}

// Opens at the pointer, or under the element when opened from the keyboard (Shift+F10 reports 0,0).
export function menuPosition(event: React.MouseEvent<HTMLElement>): MenuPosition {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY }
  const rect = event.currentTarget.getBoundingClientRect()
  return { x: rect.left + 24, y: rect.bottom }
}
