import { useMemo, useRef } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { Check, ChevronDown, Folder, Layers, Search } from 'lucide-react'
import type { ProjectSummary } from '../types'
import { ProjectAvatar } from './ProjectAvatar'

// The sidebar's section label as a searchable menu (Base UI Combobox with its input inside the
// popup): All projects, or one project to show only its threads. "" means all.
type Choice = { path: string; name: string }

export function ProjectFilter({
  value,
  paths,
  projects,
  projectName,
  projectIcons,
  onChange,
}: {
  value: string
  paths: string[]
  projects: ProjectSummary[]
  projectName: (path: string) => string
  projectIcons: boolean
  onChange: (path: string) => void
}) {
  const names = paths.map(projectName).join('\n')
  const items = useMemo(
    () =>
      Combobox.createItems(
        [
          { path: '', name: 'All projects' },
          ...paths.map((path) => ({ path, name: projectName(path) })),
        ] satisfies Choice[],
        { getValue: (choice) => choice.path, getLabel: (choice) => choice.name },
      ),
    // Rebuilt only when the projects or their names change, not on every sidebar render.
    [paths.join('\n'), names],
  )
  const icon = (path: string) =>
    !path ? (
      <Layers size={14} />
    ) : projectIcons ? (
      <ProjectAvatar
        path={path}
        name={projectName(path)}
        project={projects.find((project) => project.path === path)}
      />
    ) : (
      <Folder size={13} />
    )
  const text = value ? projectName(value) : 'All projects'
  // After a pick, focus doesn't go back to the trigger (its focus ring would linger); typing
  // still reaches the composer. Escape returns focus to the trigger as usual.
  const picked = useRef(false)
  return (
    <Combobox.Root
      items={items}
      value={value}
      onValueChange={(next) => {
        picked.current = true
        onChange(next ?? '')
      }}
      onOpenChange={(open) => {
        if (open) picked.current = false
      }}
    >
      <Combobox.Trigger className="project-filter" aria-label={`Show threads from: ${text}`}>
        {value ? icon(value) : null}
        <span>{text}</span>
        <ChevronDown size={12} className="picker-chevron" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          className="picker-positioner"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <Combobox.Popup
            className="picker-menu project-filter-menu"
            finalFocus={() => !picked.current}
            aria-label="Show threads from"
          >
            <label className="project-filter-search">
              <Search size={13} />
              <Combobox.Input placeholder="Find a project" aria-label="Find a project" />
            </label>
            <Combobox.Empty className="project-filter-empty">No projects found.</Combobox.Empty>
            <Combobox.List className="project-filter-list">
              {(choice: Choice) => (
                <Combobox.Item
                  key={choice.path}
                  value={choice.path}
                  className="project-filter-item"
                >
                  <span className="project-filter-option" title={choice.path || undefined}>
                    {icon(choice.path)}
                    <span>{choice.name}</span>
                  </span>
                  <Combobox.ItemIndicator className="picker-check">
                    <Check size={14} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
