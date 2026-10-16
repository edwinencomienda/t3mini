import { Avatar } from '@base-ui/react/avatar'
import { switchSetting } from '../switch-setting'

// Settings → Appearance → Project icons: avatars (on) or the plain folder icons (off).
const setting = switchSetting('t3-mini:project-icons')
export const saveProjectIcons = setting.save
// Starts on so the sidebar doesn't flash folders before the saved choice is read.
export const useProjectIcons = () => setting.useSetting(true)

// A project's avatar in the sidebar (Base UI Avatar): its own icon (favicon or app icon, served
// by the server from a few well-known files) when it has one, otherwise — and while the icon
// loads, or if it fails — its first letter on a color picked from its name, so each project
// keeps the same look.

const hue = (name: string) => {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}
const initial = (name: string) => (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?').toUpperCase()

export function ProjectAvatar({
  path,
  name,
  icon,
}: {
  path: string
  name: string
  icon?: boolean
}) {
  return (
    <Avatar.Root
      className="project-avatar"
      style={{ '--avatar-hue': hue(name) } as React.CSSProperties}
    >
      {icon ? (
        <Avatar.Image
          className="project-avatar-image"
          src={`/api/projects/icon?path=${encodeURIComponent(path)}`}
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
