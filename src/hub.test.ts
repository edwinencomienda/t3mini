import { expect, it } from 'vitest'
import {
  apiBaseFor,
  hubSummary,
  isRemote,
  machinePath,
  parseRemote,
  remoteId,
  threadApi,
} from './hub'
import type { ThreadSummary } from './types'

const machine = { id: 'machine-1', name: 'Cloud dev server' }

it('gives a machine’s threads and folders ids that carry the machine', () => {
  const id = remoteId(machine.id, 'thread-1')
  expect(parseRemote(id)).toEqual({ machine: machine.id, id: 'thread-1' })
  expect(isRemote(id)).toBe(true)
  // Folder paths keep their slashes.
  expect(parseRemote(remoteId(machine.id, '/home/t3/app'))?.id).toBe('/home/t3/app')
  // This computer's ids and folders aren't remote.
  for (const local of ['thread-1', '/Users/me/app', '', null, undefined, 'm~broken'])
    expect(parseRemote(local)).toBeNull()
})
it('routes a thread’s calls to its machine', () => {
  expect(threadApi('t1')).toBe('threads/t1')
  expect(threadApi('t1', 'send')).toBe('threads/t1/send')
  expect(threadApi(remoteId(machine.id, 't1'), 'send')).toBe(`m/${machine.id}/threads/t1/send`)
  expect(apiBaseFor('t1')).toBe('/api')
  expect(apiBaseFor(remoteId(machine.id, 't1'))).toBe(`/api/m/${machine.id}`)
})
it('labels a machine’s summaries and shows their real folder', () => {
  const summary = hubSummary(machine, {
    id: 't1',
    cwd: '/home/t3/app',
    title: 'x',
  } as ThreadSummary)
  expect(summary).toMatchObject({ id: remoteId(machine.id, 't1'), machine: 'Cloud dev server' })
  expect(machinePath(summary.cwd)).toBe('/home/t3/app')
  expect(machinePath('/Users/me/app')).toBe('/Users/me/app')
})
