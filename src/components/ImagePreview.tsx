import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ExternalLink, X } from 'lucide-react'

// One preview dialog for every image in the chat. Images open it with openImagePreview(); a
// plain click previews, while ⌘/Ctrl/middle-click still opens the file in a new tab.
type Preview = { src: string; alt: string; caption?: string }
const eventName = 't3-mini:preview-image'

export function openImagePreview(preview: Preview) {
  window.dispatchEvent(new CustomEvent<Preview>(eventName, { detail: preview }))
}
// For an <a href={src}> around an image: preview on a plain click, keep new-tab gestures.
export function previewOnClick(preview: Preview) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return
    event.preventDefault()
    openImagePreview(preview)
  }
}

export function ImagePreview() {
  const [preview, setPreview] = useState<Preview | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const open = (event: Event) => setPreview((event as CustomEvent<Preview>).detail)
    window.addEventListener(eventName, open)
    return () => window.removeEventListener(eventName, open)
  }, [])
  useEffect(() => {
    if (preview && !dialog.current?.open) dialog.current?.showModal()
  }, [preview])
  if (!preview) return null
  const close = () => {
    dialog.current?.close()
    setPreview(null)
  }
  return (
    <dialog
      ref={dialog}
      className="image-preview"
      aria-label={preview.caption || preview.alt}
      onClose={() => setPreview(null)}
      // Clicking the dimmed area around the image closes it.
      onClick={(event) => {
        if (event.target === dialog.current || event.target === event.currentTarget.firstChild)
          close()
      }}
    >
      <div className="image-preview-stage">
        <img src={preview.src} alt={preview.alt} />
      </div>
      <div className="image-preview-bar">
        <span>{preview.caption}</span>
        <a href={preview.src} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={13} />
          Open original
        </a>
        <button type="button" className="icon-button" aria-label="Close preview" onClick={close}>
          <X size={16} />
        </button>
      </div>
    </dialog>
  )
}
