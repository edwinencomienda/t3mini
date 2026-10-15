import { z } from 'zod'
import type { ProcessInfo } from '../processes'
import { defineTool } from './types'

// Tools for long-running processes (dev servers, watchers, queues…). Unlike a Bash call, these
// keep running after the tool returns, show up in t3 mini's process indicator, and can be
// stopped, restarted, and read later by the agent or the user.

const describe = (info: ProcessInfo) =>
  [
    `${info.name} (id ${info.id}): ${info.status}`,
    info.url ? `URL: ${info.url}` : '',
    `Command: ${info.command}`,
    info.exitCode !== undefined && info.exitCode !== null ? `Exit code: ${info.exitCode}` : '',
  ]
    .filter(Boolean)
    .join('\n')
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const startProcess = defineTool({
  name: 'start_process',
  label: 'Start process',
  description:
    'Start a long-running process (dev server, file watcher, worker…) that keeps running in the ' +
    'background, and show it in t3 mini’s process list where the user can see its logs, restart, ' +
    'or stop it. Use this instead of running such commands with Bash (which would block). ' +
    'Returns its id, status, any local URL it printed, and its first output. Use process_logs to ' +
    'read more output later.',
  input: {
    name: z
      .string()
      .min(1)
      .max(60)
      .describe('Short name shown to the user, e.g. "Web dev server".'),
    command: z.string().min(1).max(2000).describe('Shell command to run, e.g. "npm run dev".'),
    cwd: z
      .string()
      .max(500)
      .optional()
      .describe('Folder to run in, relative to the project. Defaults to the project folder.'),
  },
  // Runs a command: asks Allow once / Decline unless the thread has full access.
  safety: 'approval',
  summarize: (input) => input.command,
  async run(context, input) {
    const info = await context.processes.start(input)
    // Give it a moment to print its URL or fail fast, so the agent knows how it went.
    for (let waited = 0; waited < 3000 && !info.url && info.status === 'running'; waited += 250)
      await wait(250)
    const output = context.processes.logs(info.id, 30).trim()
    return `${describe(info)}\n\nFirst output:\n${output || '(no output yet)'}`
  },
})

export const listProcesses = defineTool({
  name: 'list_processes',
  label: 'List processes',
  description: 'List the long-running processes in this project (running and recently finished).',
  input: {},
  safety: 'safe',
  async run(context) {
    const list = context.processes.list()
    return list.length ? list.map(describe).join('\n\n') : 'No processes in this project.'
  },
})

export const processLogs = defineTool({
  name: 'process_logs',
  label: 'Process logs',
  description: 'Read the latest output of a process started with start_process.',
  input: {
    id: z.string().min(1).describe('The process id from start_process or list_processes.'),
    lines: z.number().int().min(1).max(2000).optional().describe('How many lines (default 200).'),
  },
  safety: 'safe',
  summarize: (input) => input.id,
  async run(context, input) {
    const output = context.processes.logs(input.id, input.lines ?? 200)
    return output.trim() || '(no output yet)'
  },
})

export const stopProcess = defineTool({
  name: 'stop_process',
  label: 'Stop process',
  description: 'Stop a process started with start_process (and everything it started).',
  input: { id: z.string().min(1).describe('The process id.') },
  safety: 'safe',
  summarize: (input) => input.id,
  async run(context, input) {
    return describe(await context.processes.stop(input.id))
  },
})

export const restartProcess = defineTool({
  name: 'restart_process',
  label: 'Restart process',
  description: 'Stop a process and start the same command again (e.g. after changing config).',
  input: { id: z.string().min(1).describe('The process id.') },
  safety: 'approval',
  summarize: (input) => input.id,
  async run(context, input) {
    const info = await context.processes.restart(input.id)
    for (let waited = 0; waited < 3000 && !info.url && info.status === 'running'; waited += 250)
      await wait(250)
    return describe(info)
  },
})

export const processTools = [startProcess, listProcesses, processLogs, stopProcess, restartProcess]
