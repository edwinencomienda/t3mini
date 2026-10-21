import { useEffect, useState, type MouseEvent } from 'react'
import { Modal } from './Modal'
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'
import type { Message } from '../types'

// One preview dialog for every image in the chat. Images open it with openImagePreview(); a
// plain click previews, while ⌘/Ctrl/middle-click still opens the file in a new tab. ← / → (or
// the arrows on screen) step through the open thread's other images.
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

// The open thread's images in order: what you attached and what the agent showed. Workspace
// keeps it current; the preview reads it when it opens. Older turns that aren't drawn yet are
// included, since this comes from the thread itself.
let gallery: Preview[] = []
export function setPreviewGallery(images: Preview[]) {
  gallery = images
}
// `base`: "/api" here, or a machine's (src/hub.ts apiBaseFor) for its thread's images.
export const uploadUrl = (id: string, base = '/api') => `${base}/uploads/${encodeURIComponent(id)}`
export function threadImages(messages: Message[], base = '/api'): Preview[] {
  return messages.flatMap((message) => [
    ...(message.attachments ?? [])
      .filter((item) => item.mimeType.startsWith('image/'))
      .map((item) => ({ src: uploadUrl(item.id, base), alt: item.name, caption: item.name })),
    ...(message.blocks ?? []).flatMap((block) =>
      block.type === 'image'
        ? [
            {
              src: uploadUrl(block.id, base),
              alt: block.caption || 'Image from the agent',
              ...(block.caption ? { caption: block.caption } : {}),
            },
          ]
        : [],
    ),
  ])
}

export function ImagePreview() {
  const [state, setState] = useState<{ images: Preview[]; index: number } | null>(null)
  useEffect(() => {
    const open = (event: Event) => {
      const preview = (event as CustomEvent<Preview>).detail
      const index = gallery.findIndex((item) => item.src === preview.src)
      setState(index >= 0 ? { images: gallery, index } : { images: [preview], index: 0 })
    }
    window.addEventListener(eventName, open)
    return () => window.removeEventListener(eventName, open)
  }, [])
  const count = state?.images.length ?? 0
  const index = state?.index ?? 0
  const step = (by: number) =>
    setState((current) =>
      current
        ? {
            ...current,
            index: Math.max(0, Math.min(current.images.length - 1, current.index + by)),
          }
        : current,
    )
  useEffect(() => {
    if (count < 2) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        step(event.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    // Capture: the dialog handles keys inside it before they'd bubble up to the window.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [count])
  // Load the neighbors ahead of time, so stepping to them is instant.
  useEffect(() => {
    if (!state) return
    for (const near of [state.images[index - 1], state.images[index + 1]])
      if (near) new Image().src = near.src
  }, [state, index])
  if (!state) return null
  const preview = state.images[index]!
  const close = () => setState(null)
  return (
    <Modal
      className="image-preview"
      backdropClassName="image-preview-backdrop"
      label={preview.caption || preview.alt}
      onClose={close}
      // The image fills the screen, so clicks on the dimmed area around it land in the popup.
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target === event.currentTarget.firstChild)
          close()
      }}
    >
      <div className="image-preview-stage">
        <img key={preview.src} src={preview.src} alt={preview.alt} />
        {count > 1 ? (
          <>
            <button
              type="button"
              className="image-preview-step previous"
              aria-label="Previous image"
              title="Previous image (←)"
              disabled={index === 0}
              onClick={() => step(-1)}
            >
              <ChevronLeft size={22} />
            </button>
            <button
              type="button"
              className="image-preview-step next"
              aria-label="Next image"
              title="Next image (→)"
              disabled={index === count - 1}
              onClick={() => step(1)}
            >
              <ChevronRight size={22} />
            </button>
          </>
        ) : null}
      </div>
      <div className="image-preview-bar">
        {count > 1 ? (
          <span className="image-preview-count" aria-live="polite">
            {index + 1} of {count}
          </span>
        ) : null}
        <span>{preview.caption}</span>
        <a href={preview.src} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={13} />
          Open original
        </a>
        <button type="button" className="icon-button" aria-label="Close preview" onClick={close}>
          <X size={16} />
        </button>
      </div>
    </Modal>
  )
}
