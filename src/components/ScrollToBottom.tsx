import { useEffect, useState, type RefObject } from 'react'
import { ArrowDown } from 'lucide-react'

// A round "scroll to bottom" button above the composer, shown once you've scrolled up from the
// latest message. It watches the chat's scroll itself, so scrolling never re-renders the
// thread view. (A plain button: Base UI has no scroll-position component.)
const showAfter = 200

export function ScrollToBottom({
  scrollArea,
  stickToBottom,
}: {
  scrollArea: RefObject<HTMLDivElement | null>
  stickToBottom: RefObject<boolean>
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = scrollArea.current
    if (!element) return
    const update = () =>
      setVisible(element.scrollHeight - element.scrollTop - element.clientHeight > showAfter)
    update()
    element.addEventListener('scroll', update, { passive: true })
    // The content growing (an agent's reply streaming in) moves the bottom too.
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scrollArea])
  if (!visible) return null
  return (
    <button
      type="button"
      className="scroll-to-bottom"
      title="Scroll to bottom"
      aria-label="Scroll to bottom"
      onClick={() => {
        const element = scrollArea.current
        if (!element) return
        // Follow new output again from here on.
        stickToBottom.current = true
        const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
        // Messages below lay out as they come into view, so the bottom moves while we scroll:
        // once the scroll settles, land on the real bottom (unless you scrolled away meanwhile).
        let last = -1
        let still = 0
        let frames = 0
        let cancelled = false
        const cancel = () => (cancelled = true)
        element.addEventListener('wheel', cancel, { once: true, passive: true })
        element.addEventListener('touchstart', cancel, { once: true, passive: true })
        const settle = () => {
          if (cancelled) return
          still = element.scrollTop === last ? still + 1 : 0
          last = element.scrollTop
          if (still < 3 && ++frames < 120) return void requestAnimationFrame(settle)
          element.removeEventListener('wheel', cancel)
          element.removeEventListener('touchstart', cancel)
          stickToBottom.current = true
          element.scrollTop = element.scrollHeight
        }
        requestAnimationFrame(settle)
      }}
    >
      <ArrowDown size={16} />
    </button>
  )
}
