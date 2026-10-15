// Rich content that tools add to an agent's reply, shared by the server (which saves it with the
// thread) and the client (which renders each type with its own component). New block types go
// here, with a renderer in src/components/blocks.tsx.
export type ImageBlock = { type: 'image'; id: string; caption?: string }
export type Block = ImageBlock
