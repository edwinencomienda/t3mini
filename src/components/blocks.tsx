import { useEffect, useRef, useState } from 'react'
import { StatusCard } from './StatusCard'
import { useApiBase } from '../hub'
import { ExternalLink, Music } from 'lucide-react'
import type { AudioBlock, Block, ImageBlock, VideoBlock } from '../blocks'
import { Diagram } from './Diagram'
import { HtmlView } from './HtmlView'
import { previewOnClick } from './ImagePreview'
import { imageLoading } from '../loaded-images'

// Renders the rich content tools add to agent replies. Each block type gets one component;
// add new types (charts, tables…) to the switch.
function ImageView({ block }: { block: ImageBlock }) {
  const src = `${useApiBase()}/uploads/${encodeURIComponent(block.id)}`
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
          {...imageLoading(src)}
          decoding="async"
        />
      </a>
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
    </figure>
  )
}

// Media lives with the thread: here, or on its machine (the hub's ApiBase).
const mediaUrl = (base: string, id: string) => `${base}/media/${encodeURIComponent(id)}`

// When a turn finishes, its media moves into the final answer, so the player is replaced by a
// new one. One you were playing carries on in the new player from where it was (this only
// continues what you started; nothing starts on its own).
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
  const src = mediaUrl(useApiBase(), block.id)
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

// Sounds used to play on their own once and were remembered here; that's gone, so drop the list.
try {
  if (typeof localStorage !== 'undefined') localStorage.removeItem('t3-mini:played-sounds')
} catch {
  // Storage unavailable: nothing to clean up.
}

// A sound from the agent (play_audio). It never starts on its own: you press play.
function AudioView({ block }: { block: AudioBlock }) {
  const player = useRef<HTMLAudioElement>(null)
  const [failed, setFailed] = useState(false)
  const src = mediaUrl(useApiBase(), block.id)
  useCarryOn(player, block.id)
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
          case 'status':
            return <StatusCard key={`status:${block.id}`} block={block} />
          default:
            // A block type this version doesn't know yet: skip it rather than break the chat.
            return <span key={index} hidden />
        }
      })}
    </div>
  )
}
