import { Avatar } from '@base-ui/react/avatar'
import { MessageSquareDashed } from 'lucide-react'
import { switchSetting } from '../switch-setting'
import type { ProjectSummary } from '../types'

// Settings → Appearance → Project icons: avatars (on) or the plain folder icons (off).
const setting = switchSetting('t3-mini:project-icons', 'projectIcons')
export const saveProjectIcons = setting.save
// Starts on so the sidebar doesn't flash folders before the saved choice is read.
export const useProjectIcons = () => setting.useSetting(true)

// A project's avatar in the sidebar (Base UI Avatar): the image chosen in Project settings, or
// automatically its own icon (favicon or app icon, served by the server from a few well-known
// files) when it has one. Otherwise — and while the image loads, or if it fails — its first
// letter on a color picked from its name, so each project keeps the same look.

const hue = (name: string) => {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}
const initial = (name: string) => (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?').toUpperCase()

export function avatarSrc(
  path: string,
  project?: Pick<ProjectSummary, 'avatar' | 'image' | 'icon'>,
) {
  if (project?.avatar === 'image' && project.image)
    return `/api/uploads/${encodeURIComponent(project.image)}`
  if (project?.avatar !== 'letter' && project?.icon)
    return `/api/projects/icon?path=${encodeURIComponent(path)}`
  return undefined
}

export function ProjectAvatar({
  path,
  name,
  project,
  size,
}: {
  path: string
  name: string
  project?: Pick<ProjectSummary, 'avatar' | 'image' | 'icon' | 'chats'>
  // Larger, for Project settings.
  size?: 'large'
}) {
  // "No project" (chats): a chat bubble instead of a letter.
  if (project?.chats)
    return (
      <span className={`project-avatar chats ${size ?? ''}`} aria-hidden>
        <MessageSquareDashed size={size === 'large' ? 22 : 12} />
      </span>
    )
  const src = avatarSrc(path, project)
  return (
    <Avatar.Root
      className={`project-avatar ${size ?? ''} ${project?.avatar === 'image' ? 'custom' : ''}`}
      style={{ '--avatar-hue': hue(name) } as React.CSSProperties}
    >
      {src ? (
        <Avatar.Image
          key={src}
          className="project-avatar-image"
          src={src}
          alt=""
          width={16}
          height={16}
        />
      ) : null}
      <Avatar.Fallback className="project-avatar-letter" aria-hidden>
        {initial(name)}
      </Avatar.Fallback>
    </Avatar.Root>
  )
}
