import type { PageLibrary } from './html-page'
// Rich content that tools add to an agent's reply, shared by the server (which saves it with the
// thread) and the client (which renders each type with its own component). New block types go
// here, with a renderer in src/components/blocks.tsx.
export type ImageBlock = { type: 'image'; id: string; caption?: string }
// A Mermaid diagram, drawn in the browser (see src/diagrams.ts). Only the source text is saved.
export type DiagramBlock = { type: 'diagram'; source: string; title?: string }
// A small HTML page from the agent (show_html), shown in a sealed sandbox (HtmlView.tsx). The
// page itself is stored with the uploads; the block only references it. key: the agent's name
// for it, so a later call in the same turn replaces it (a fix) instead of adding another;
// libraries: bundled libraries inlined into the page (src/html-page.ts).
export type HtmlBlock = {
  type: 'html'
  id: string
  title?: string
  key?: string
  libraries?: PageLibrary[]
}
// A video or sound from the agent (show_video, play_audio), stored with the uploads and streamed
// from /api/media/:id. Neither plays on its own: you press play. (Sounds saved before this may
// still carry `autoplay`/`at` fields; they're ignored.)
export type VideoBlock = { type: 'video'; id: string; caption?: string }
export type AudioBlock = { type: 'audio'; id: string; caption?: string }
// A live status card from the agent (show_status): a push, pull request, deploy, release, or
// any other long step. The agent updates it in place by id within a turn; t3 mini picks the
// icon and colors from `kind` and `status`, so the agent never sends markup or images.
export const statusKinds = ['push', 'pr', 'deploy', 'release', 'task'] as const
export const statusStates = ['running', 'done', 'failed'] as const
export type StatusKind = (typeof statusKinds)[number]
// stopped: still running when the turn ended (set by t3 mini, never by the agent).
export type StatusState = (typeof statusStates)[number] | 'stopped'
export type StatusBlock = {
  type: 'status'
  id: string
  kind: StatusKind
  status: StatusState
  title: string
  detail?: string
  stages?: string[]
  stage?: string
  commits?: { sha: string; message: string }[]
  // Always https (checked by the tool, and again when drawn).
  url?: string
  urlLabel?: string
  error?: string
  // Set by t3 mini: when the card first appeared and when it finished.
  startedAt: string
  endedAt?: string
}
export type Block = ImageBlock | DiagramBlock | HtmlBlock | VideoBlock | AudioBlock | StatusBlock
