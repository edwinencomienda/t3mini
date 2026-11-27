import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { ToolError, defineTool } from './types'

// Where an agent may add (or create) a project: a folder inside the home folder, never the
// home folder itself, and never inside a hidden folder (~/.ssh, ~/.config, ~/.t3-mini…). The
// approval card is the main guard, but threads with full access skip it, so the rule holds
// either way. `home` is the real (symlink-free) home folder.
export function projectFolderProblem(path: string, home: string): string | undefined {
  const inside = relative(home, path)
  if (!inside || inside === '.') return 'Your home folder itself can’t be a project.'
  if (inside.startsWith('..') || isAbsolute(inside))
    return 'Projects added by an agent must be inside your home folder (~/…).'
  if (inside.split(sep).some((part) => part.startsWith('.')))
    return 'Projects added by an agent can’t be in a hidden folder (one starting with a dot).'
  return undefined
}

// ~ and relative paths (from the thread's folder) to an absolute one.
export function expandPath(input: string, cwd: string, home = homedir()) {
  if (input === '~') return home
  if (input.startsWith('~/')) return join(home, input.slice(2))
  return resolve(cwd, input)
}

// The folder with every symlink resolved, also for a folder that doesn't exist yet (its
// nearest existing parent resolved, the missing rest appended), so a link can't lead outside
// the allowed area. exists: whether the folder itself is already there.
export async function realFolder(path: string): Promise<{ path: string; exists: boolean }> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      const real = await realpath(current)
      if (!missing.length) {
        if (!(await stat(real)).isDirectory()) throw new ToolError(`Not a folder: ${path}`)
        return { path: real, exists: true }
      }
      if (!(await stat(real)).isDirectory()) throw new ToolError(`Not a folder: ${current}`)
      return { path: join(real, ...missing.reverse()), exists: false }
    } catch (error) {
      if (error instanceof ToolError) throw error
      const parent = dirname(current)
      if (parent === current) throw new ToolError(`Can’t reach ${path}.`)
      missing.push(basename(current))
      current = parent
    }
  }
}

export const addProject = defineTool({
  name: 'add_project',
  label: 'Add project',
  description:
    'Add a folder to t3 mini as a project (it appears in the sidebar, where the user can start ' +
    'threads in it), optionally creating the folder first. Use it only when the user asks to ' +
    'add or create a project. The folder must be inside the home folder and not in a hidden ' +
    'folder; give an absolute path, a path starting with ~/, or one relative to your current ' +
    'folder. Adding a folder that is already a project just reports it. It does not start a ' +
    'thread there or set the folder up (git init, scaffolding): do that separately if asked.',
  input: {
    path: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .describe('The project folder, e.g. "~/projects/myapp".'),
    create: z
      .boolean()
      .default(false)
      .describe('Create the folder (and missing parents) if it doesn’t exist yet.'),
  },
  safety: 'approval',
  summarize: (input) => input.path || undefined,
  async run(context, input) {
    const home = await realpath(homedir())
    const target = await realFolder(expandPath(input.path, context.cwd))
    const problem = projectFolderProblem(target.path, home)
    if (problem) throw new ToolError(problem)
    if (!target.exists && !input.create)
      throw new ToolError(
        `The folder ${target.path} doesn’t exist. Pass create: true to create it, if the user wants a new folder.`,
      )
    // Checked again on the folder actually saved, in case it changed in between.
    const { project, added } = await context.addProject(target.path, {
      create: !target.exists,
      check: (path) => {
        const again = projectFolderProblem(path, home)
        if (again) throw new ToolError(again)
      },
    })
    const name = project.name || basename(project.path)
    if (!added) return `${project.path} is already a project ("${name}"). Nothing changed.`
    return (
      `${target.exists ? 'Added' : 'Created and added'} the project "${name}" (${project.path}). ` +
      'It is in the sidebar now, with no threads yet.'
    )
  },
})
