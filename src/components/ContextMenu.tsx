import { useMemo, type ReactNode } from 'react'
import { Menu } from '@base-ui/react/menu'

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

// Right-click (or ⋮) menu at the pointer. Base UI's Menu handles focus, keyboard navigation,
// dismissal, and keeping it inside the window; it's anchored to a zero-size point.
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
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => DOMRect.fromRect({ ...position, width: 0, height: 0 }) }),
    [position],
  )
  return (
    <Menu.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Menu.Portal>
        <Menu.Positioner
          className="context-menu-positioner"
          anchor={anchor}
          side="bottom"
          align="start"
          collisionPadding={8}
        >
          <Menu.Popup
            className="context-menu"
            aria-label={label}
            onContextMenu={(event) => event.preventDefault()}
          >
            {items.map((item, index) =>
              item === 'separator' ? (
                <Menu.Separator className="context-menu-separator" key={index} />
              ) : (
                <Menu.Item
                  key={item.label}
                  className={item.danger ? 'danger' : undefined}
                  disabled={item.disabled}
                  title={item.title}
                  label={item.label}
                  onClick={() => item.onSelect()}
                >
                  {item.icon}
                  {item.label}
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

// Opens at the pointer, or under the element when opened from the keyboard (Shift+F10 reports 0,0).
export function menuPosition(event: React.MouseEvent<HTMLElement>): MenuPosition {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY }
  const rect = event.currentTarget.getBoundingClientRect()
  return { x: rect.left + 24, y: rect.bottom }
}
