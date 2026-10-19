import { useRef, useState, type FormEvent } from 'react'
import { ImageUp, X } from 'lucide-react'
import { Modal, ModalTitle } from './Modal'
import { ProjectAvatar } from './ProjectAvatar'
import { Segmented } from './ui'
import { prepareImage, uploadFile } from '../attachments'
import type { ProjectSummary } from '../types'

// Project settings (right-click a project or one of its threads): its name and its avatar.
// The avatar is automatic (the project's own icon, else its letter), its letter, or an image
// you upload; uploads go through the usual image checks (PNG, JPEG, GIF, or WebP, read from
// the bytes).

type Choice = 'auto' | 'letter' | 'image'

async function post(path: string, body: unknown) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Could not save the project settings.')
}

export function ProjectSettings({
  path,
  project,
  projectIcons,
  onClose,
}: {
  path: string
  project?: ProjectSummary
  // Settings → Appearance → Project icons; when off the sidebar shows folders instead.
  projectIcons: boolean
  onClose: () => void
}) {
  const folder = path.split('/').filter(Boolean).pop() ?? path
  const [name, setName] = useState(project?.name ?? '')
  const [choice, setChoice] = useState<Choice>(project?.avatar ?? 'auto')
  const [image, setImage] = useState(project?.image)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)

  async function choose(file: File | undefined) {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const prepared = await prepareImage(file)
      if (!prepared) throw new Error('That file isn’t an image t3 mini can use.')
      const uploaded = await uploadFile(prepared, 'image')
      if (uploaded.kind !== 'image') throw new Error('That file isn’t an image.')
      setImage(uploaded.id)
      setChoice('image')
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setUploading(false)
      if (picker.current) picker.current.value = ''
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (choice === 'image' && !image) {
      setError('Choose an image first.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (name.trim() !== (project?.name ?? ''))
        await post('projects/rename', { path, name: name.trim() })
      if (
        choice !== (project?.avatar ?? 'auto') ||
        (choice === 'image' && image !== project?.image)
      )
        await post('projects/avatar', {
          path,
          avatar: choice,
          ...(choice === 'image' ? { image } : {}),
        })
      onClose()
    } catch (error) {
      setError((error as Error).message)
      setBusy(false)
    }
  }
  const hint =
    choice === 'image'
      ? 'PNG, JPEG, GIF, or WebP. Square images look best.'
      : choice === 'letter'
        ? 'Its first letter, on a color picked from its name.'
        : project?.icon
          ? 'This project’s own icon (its favicon or app icon).'
          : 'No icon found in this project, so its first letter is used.'
  return (
    <Modal
      className="new-dialog project-settings"
      onClose={() => {
        if (!busy && !uploading) onClose()
      }}
    >
      <form onSubmit={save}>
        <div className="dialog-top">
          <ModalTitle render={<h2 />}>Project settings</ModalTitle>
          <button
            className="icon-button"
            type="button"
            aria-label="Close project settings"
            disabled={busy || uploading}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="project-settings-head">
          <ProjectAvatar
            path={path}
            name={name.trim() || folder}
            project={{
              ...(project?.icon ? { icon: true } : {}),
              ...(choice !== 'auto' ? { avatar: choice } : {}),
              ...(choice === 'image' && image ? { image } : {}),
            }}
            size="large"
          />
          <div>
            <strong>{name.trim() || folder}</strong>
            <code title={path}>{path}</code>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="project-name">
            Name
          </label>
          <input
            id="project-name"
            autoFocus
            value={name}
            maxLength={80}
            placeholder={folder}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
          <small className="field-hint">Leave it empty to use the folder name.</small>
        </div>
        <div className="field">
          <span className="field-label">Avatar</span>
          <div className="project-settings-avatar">
            <Segmented
              label="Avatar"
              value={choice}
              onChange={(next) => {
                setChoice(next)
                // Image with nothing chosen yet: ask for one right away.
                if (next === 'image' && !image) picker.current?.click()
              }}
              options={[
                { value: 'auto', label: 'Automatic' },
                { value: 'letter', label: 'Letter' },
                { value: 'image', label: 'Image' },
              ]}
            />
            {choice === 'image' ? (
              <button
                type="button"
                className="secondary"
                disabled={busy || uploading}
                onClick={() => picker.current?.click()}
              >
                <ImageUp size={14} />
                {uploading ? 'Uploading…' : image ? 'Replace…' : 'Choose…'}
              </button>
            ) : null}
          </div>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          <small className="field-hint">{hint}</small>
          {!projectIcons ? (
            <small className="field-hint">
              Project icons are off (Settings → Appearance), so the sidebar shows folders.
            </small>
          ) : null}
        </div>
        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button
            className="secondary"
            type="button"
            onClick={onClose}
            disabled={busy || uploading}
          >
            Cancel
          </button>
          <button className="primary" disabled={busy || uploading}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
