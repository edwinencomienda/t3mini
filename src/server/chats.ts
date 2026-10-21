import { mkdir, readdir, realpath, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

// Threads without a project ("No project", like T3 Code's scratch threads). They all belong to
// one folder t3 mini manages, ~/.t3-mini/chats, which the sidebar shows as "No project" (never
// saved as a project), and each one works in a folder of its own inside it, named from the date
// and its first message, e.g. 2026-10-21-fix-my-resume-a1b2c3d4. Outside any repository, so
// chats never pick up a repo's git status.

export const chatsRoot = () => process.env.T3_MINI_CHATS_DIR || join(homedir(), '.t3-mini', 'chats')

export async function ensureChatsRoot() {
  await mkdir(chatsRoot(), { recursive: true, mode: 0o700 })
  return realpath(chatsRoot())
}

const folderWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/, '')

// Makes the chat's own folder (a new one, never an existing folder).
export async function createChatFolder(root: string, threadId: string, text: string) {
  const date = new Date().toISOString().slice(0, 10)
  const id = threadId.replace(/[^0-9a-f]/gi, '').slice(0, 8)
  // A helper's first message starts with a note about its lead; name it from its task.
  const words = folderWords(text.replace(/^\[[^\]]*\]\s*/, ''))
  const base = join(root, [date, words, id].filter(Boolean).join('-'))
  for (let attempt = 0; attempt < 5; attempt++) {
    const folder = attempt ? `${base}-${attempt + 1}` : base
    try {
      await mkdir(folder, { mode: 0o700 })
      return folder
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not create a folder for this chat.')
}

// After a chat is deleted: its folder goes only if it's empty (files the agent made stay) and
// only inside the chats folder. Returns the folder when it was kept.
export async function removeChatFolder(folder: string) {
  const root = await realpath(chatsRoot()).catch(() => null)
  const path = await realpath(folder).catch(() => null)
  if (!root || !path) return undefined
  const inside = relative(root, path)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return undefined
  if ((await readdir(path)).length) return path
  await rmdir(path).catch(() => {})
  return undefined
}
