import type { Block, ImageBlock } from '../blocks'
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
          default:
            // A block type this version doesn't know yet: skip it rather than break the chat.
            return <span key={index} hidden />
        }
      })}
    </div>
  )
}
