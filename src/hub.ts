import { createContext, useContext } from 'react'
import type { ProjectSummary, Thread, ThreadSummary } from './types'

// The hub: one sidebar for this computer and every machine added under Settings → Machines
// (docs/machines.md). A machine's threads keep living on that machine; this browser reads them
// through this server at /api/m/<machine>/… (machines.ts forward()), which adds the machine's
// session. Here their ids and project folders carry the machine, "m~<machine>~<thread id>", so
// they never mix with this computer's (the same folder path can exist on both) and every call
// for them goes to the right place.

const mark = 'm~'

export const remoteId = (machine: string, value: string) => `${mark}${machine}~${value}`

// The machine and the machine's own id (or folder) for a hub id; null for this computer's.
export function parseRemote(value: string | null | undefined) {
  if (!value?.startsWith(mark)) return null
  const rest = value.slice(mark.length)
  const split = rest.indexOf('~')
  if (split <= 0) return null
  return { machine: rest.slice(0, split), id: rest.slice(split + 1) }
}
export const isRemote = (value: string | null | undefined) => parseRemote(value) !== null

// The API path (after /api/) for a thread, or for one of its actions: "threads/<id>/send" here,
// "m/<machine>/threads/<id>/send" for a machine's thread.
export function threadApi(id: string, action = '') {
  const remote = parseRemote(id)
  const base = remote
    ? `m/${encodeURIComponent(remote.machine)}/threads/${encodeURIComponent(remote.id)}`
    : `threads/${encodeURIComponent(id)}`
  return action ? `${base}/${action}` : base
}

// Where a thread's own content (images, media, HTML pages, uploads) lives: "/api" here,
// "/api/m/<machine>" for a machine's thread.
export function apiBaseFor(id: string | null | undefined) {
  const remote = parseRemote(id)
  return remote ? `/api/m/${encodeURIComponent(remote.machine)}` : '/api'
}
// The open thread's content base, for components deep in the conversation (blocks, previews).
export const ApiBase = createContext('/api')
export const useApiBase = () => useContext(ApiBase)

// A machine's summaries, projects, and threads with hub ids, labeled with the machine's name.
export type HubMachine = { id: string; name: string }
export const hubSummary = (machine: HubMachine, item: ThreadSummary): ThreadSummary => ({
  ...item,
  id: remoteId(machine.id, item.id),
  cwd: remoteId(machine.id, item.cwd),
  machine: machine.name,
})
export const hubProject = (machine: HubMachine, item: ProjectSummary): ProjectSummary => ({
  ...item,
  path: remoteId(machine.id, item.path),
  machine: machine.name,
})
export const hubThread = (machine: HubMachine, item: Thread): Thread => ({
  ...item,
  id: remoteId(machine.id, item.id),
  cwd: remoteId(machine.id, item.cwd),
  machine: machine.name,
})
// The folder a hub project or thread works in on its machine (what to show and copy).
export const machinePath = (value: string) => parseRemote(value)?.id ?? value
