import { saveSidebarWidth, sidebarWidthLimits } from '../theme'

// The sidebar's right edge: drag to resize, double-click to go back to the default width, or
// use the arrow keys. Works like the changes panel's edge; the width is remembered.
const minChat = 360
const clamp = (value: number) =>
  Math.round(
    Math.max(
      sidebarWidthLimits.min,
      Math.min(value, sidebarWidthLimits.max, window.innerWidth - minChat),
    ),
  )

export function SidebarResize() {
  const sidebarOf = (handle: HTMLElement) => handle.parentElement!.getBoundingClientRect()
  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const left = sidebarOf(handle).left
    let latest: number | null = null
    // While dragging only the CSS variable changes, so the page doesn't re-render.
    const move = (moveEvent: PointerEvent) => {
      latest = clamp(moveEvent.clientX - left)
      document.documentElement.style.setProperty('--sidebar-width', `${latest}px`)
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      document.body.classList.remove('resizing')
      handle.classList.remove('dragging')
      if (latest !== null) saveSidebarWidth(latest)
    }
    document.body.classList.add('resizing')
    handle.classList.add('dragging')
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  return (
    <div
      className="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={startResize}
      onDoubleClick={() => saveSidebarWidth(null)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const current = sidebarOf(event.currentTarget).width
        saveSidebarWidth(clamp(current + (event.key === 'ArrowRight' ? 32 : -32)))
      }}
    />
  )
}
