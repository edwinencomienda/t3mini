// Rich content that tools add to an agent's reply, shared by the server (which saves it with the
// thread) and the client (which renders each type with its own component). New block types go
// here, with a renderer in src/components/blocks.tsx.
export type ImageBlock = { type: 'image'; id: string; caption?: string }
// A Mermaid diagram, drawn in the browser (see src/diagrams.ts). Only the source text is saved.
export type DiagramBlock = { type: 'diagram'; source: string; title?: string }
// A small HTML page from the agent (show_html), shown in a sealed sandbox (HtmlView.tsx). The
// page itself is stored with the uploads; the block only references it.
export type HtmlBlock = { type: 'html'; id: string; title?: string }
// A video or sound from the agent (show_video, play_audio), stored with the uploads and streamed
// from /api/media/:id. autoplay: the agent wanted the sound played right away, so it plays once
// when it arrives (at: when that was), not again when the thread is reopened.
export type VideoBlock = { type: 'video'; id: string; caption?: string }
export type AudioBlock = {
  type: 'audio'
  id: string
  caption?: string
  autoplay?: boolean
  at?: string
}
export type Block = ImageBlock | DiagramBlock | HtmlBlock | VideoBlock | AudioBlock
