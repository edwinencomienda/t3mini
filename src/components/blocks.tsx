import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Music } from 'lucide-react'
import type { AudioBlock, Block, ImageBlock, VideoBlock } from '../blocks'
import { Diagram } from './Diagram'
import { HtmlView } from './HtmlView'
import { previewOnClick } from './ImagePreview'

// Renders the rich content tools add to agent replies. Each block type gets one component;
// add new types (charts, tables…) to the switch.
function ImageView({ block }: { block: ImageBlock }) {
  const src = `/api/uploads/${encodeURIComponent(block.id)}`
  return (
    <figure className="block-image">
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        title="Preview"
        onClick={previewOnClick({
          src,
          alt: block.caption || 'Image from the agent',
          caption: block.caption,
        })}
      >
        <img
          src={src}
          alt={block.caption || 'Image from the agent'}
          loading="lazy"
          decoding="async"
        />
      </a>
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
    </figure>
  )
}

const mediaUrl = (id: string) => `/api/media/${encodeURIComponent(id)}`

// When a turn finishes, its media moves into the final answer, so the player is replaced by a
// new one. One that was playing carries on in the new player from where it was.
const resumeAt = new Map<string, number>()
function useCarryOn(player: React.RefObject<HTMLMediaElement | null>, id: string) {
  useEffect(() => {
    const media = player.current
    if (!media) return
    const at = resumeAt.get(id)
    if (at !== undefined) {
      resumeAt.delete(id)
      media.currentTime = at
      void media.play().catch(() => {})
    }
    return () => {
      if (!media.paused && !media.ended) resumeAt.set(id, media.currentTime)
    }
  }, [player, id])
}

// A video from the agent (show_video), with the browser's own controls. Some formats (MOV,
// Ogg) don't play in every browser: then it says so and links to the file.
function VideoView({ block }: { block: VideoBlock }) {
  const player = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const src = mediaUrl(block.id)
  useCarryOn(player, block.id)
  return (
    <figure className="block-media">
      {failed ? (
        <p className="block-media-note">
          This browser can’t play this video.{' '}
          <a href={src} target="_blank" rel="noopener noreferrer">
            Open it
          </a>
        </p>
      ) : (
        <video
          ref={player}
          src={src}
          controls
          preload="metadata"
          playsInline
          onError={() => setFailed(true)}
          aria-label={block.caption || 'Video from the agent'}
        />
      )}
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
    </figure>
  )
}

// Sounds that already played in this browser, so reopening the thread or reloading the page
// doesn't play them again (kept in localStorage; the newest few are enough).
const playedKey = 't3-mini:played-sounds'
const played = (() => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(playedKey) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set<string>()
  }
})()
function markPlayed(id: string) {
  played.add(id)
  try {
    localStorage.setItem(playedKey, JSON.stringify([...played].slice(-50)))
  } catch {
    // Storage unavailable: it's still remembered until the page reloads.
  }
}
const freshMs = 60_000

// A sound from the agent (play_audio). With autoplay it plays once as it arrives: only within a
// minute of being sent, only in the tab you're looking at (not every open window), and only if
// the browser allows sound (after you've clicked or typed in the page); otherwise press play.
function AudioView({ block }: { block: AudioBlock }) {
  const player = useRef<HTMLAudioElement>(null)
  const [failed, setFailed] = useState(false)
  const src = mediaUrl(block.id)
  useCarryOn(player, block.id)
  useEffect(() => {
    const audio = player.current
    if (!audio || !block.autoplay || played.has(block.id)) return
    const age = block.at ? Date.now() - Date.parse(block.at) : Infinity
    if (!(age < freshMs) || document.visibilityState !== 'visible' || !document.hasFocus()) return
    markPlayed(block.id)
    void audio.play().catch(() => {
      // Sound not allowed yet (no click in the page): the player is there to press.
    })
  }, [block.autoplay, block.at, block.id])
  return (
    <figure className="block-media block-audio">
      <div className="block-audio-row">
        <Music size={15} aria-hidden />
        {failed ? (
          <span className="block-media-note">
            This browser can’t play this sound.{' '}
            <a href={src} target="_blank" rel="noopener noreferrer">
              Open it
            </a>
          </span>
        ) : (
          <audio
            ref={player}
            src={src}
            controls
            preload="metadata"
            onError={() => setFailed(true)}
            aria-label={block.caption || 'Sound from the agent'}
          />
        )}
        <a
          className="icon-button block-media-open"
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in a new tab"
          aria-label="Open in a new tab"
        >
          <ExternalLink size={13} />
        </a>
      </div>
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
    </figure>
  )
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="blocks">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'image':
            return <ImageView key={block.id} block={block} />
          case 'diagram':
            return <Diagram key={index} source={block.source} title={block.title} />
          case 'html':
            return <HtmlView key={block.id} id={block.id} title={block.title} />
          case 'video':
            return <VideoView key={block.id} block={block} />
          case 'audio':
            return <AudioView key={block.id} block={block} />
          default:
            // A block type this version doesn't know yet: skip it rather than break the chat.
            return <span key={index} hidden />
        }
      })}
    </div>
  )
}
