import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Gauge, Lock, LockOpen, RefreshCw, Sparkles } from 'lucide-react'
import {
  effortLabel,
  permissionModes,
  type AgentSettings,
  type ModelCatalog,
} from '../agent-settings'
import type { Provider } from '../types'

type Option = { value: string; label: string; description?: string }

function Picker({
  label,
  icon,
  text,
  value,
  options,
  onSelect,
  disabled,
  placement,
  tone,
  footer,
}: {
  label: string
  icon: ReactNode
  text: string
  value: string
  options: Option[]
  onSelect: (value: string) => void
  disabled?: boolean
  placement: 'up' | 'down'
  tone?: 'warning'
  footer?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    list.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], button')?.focus()
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  function move(event: React.KeyboardEvent) {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') || [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      root.current?.querySelector<HTMLButtonElement>('.picker-trigger')?.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(index + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Tab') setOpen(false)
  }
  return (
    <div className="picker" ref={root} onKeyDown={open ? move : undefined}>
      <button
        type="button"
        className={`picker-trigger ${tone || ''}`}
        aria-label={`${label}: ${text}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span>{text}</span>
        <ChevronDown size={12} className="picker-chevron" />
      </button>
      {open ? (
        <div className={`picker-menu ${placement}`} role="menu" aria-label={label} ref={list}>
          <div className="picker-heading">{label}</div>
          {options.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              key={option.value || 'default'}
              onClick={() => {
                onSelect(option.value)
                setOpen(false)
              }}
            >
              <span className="picker-option-text">
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </span>
              {option.value === value ? <Check size={14} /> : null}
            </button>
          ))}
          {footer}
        </div>
      ) : null}
    </div>
  )
}

export function AgentSettingsControls({
  provider,
  cwd,
  value,
  onChange,
  disabled = false,
  placement = 'up',
}: {
  provider: Provider
  cwd: string
  value: AgentSettings
  onChange: (settings: AgentSettings) => void
  disabled?: boolean
  placement?: 'up' | 'down'
}) {
  const [catalog, setCatalog] = useState<ModelCatalog>({ models: [] })
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setCatalog({ models: [] })
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ provider, cwd, ...(reload ? { refresh: '1' } : {}) })
      fetch(`/api/models?${params}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('Could not load models.')
          return response.json() as Promise<ModelCatalog>
        })
        .then(setCatalog)
        .catch(() => {
          if (!controller.signal.aborted)
            setCatalog({ models: [], error: 'Models unavailable. Use Provider default or retry.' })
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [provider, cwd, reload])
  const model = catalog.models.find((item) => item.id === value.model)
  const mode = permissionModes.find((item) => item.value === value.permissionMode)!
  const efforts = model?.efforts || []
  const modelOptions: Option[] = [
    { value: '', label: 'Provider default' },
    ...(value.model && !model && !loading ? [{ value: value.model, label: value.model }] : []),
    ...catalog.models.map((item) => ({
      value: item.id,
      label: item.label,
      description: item.description,
    })),
  ]
  const effortOptions: Option[] = [
    {
      value: '',
      label: model?.defaultEffort ? `Default (${effortLabel(model.defaultEffort)})` : 'Default',
    },
    ...(value.effort && !efforts.includes(value.effort)
      ? [{ value: value.effort, label: effortLabel(value.effort) }]
      : []),
    ...efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
  ]
  const modelText = loading
    ? value.model
      ? value.model
      : 'Loading…'
    : model?.label || value.model || 'Default model'
  return (
    <div className="agent-settings" aria-label="Agent settings" role="group">
      <Picker
        label="Model"
        icon={<Sparkles size={13} />}
        text={modelText}
        value={value.model}
        options={modelOptions}
        disabled={disabled || loading}
        placement={placement}
        onSelect={(model) => onChange({ ...value, model, effort: '' })}
        footer={
          catalog.error ? (
            <div className="picker-error">
              <span>{catalog.error}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Retry loading models"
                onClick={() => setReload((count) => count + 1)}
              >
                <RefreshCw size={13} />
              </button>
            </div>
          ) : null
        }
      />
      {efforts.length || value.effort ? (
        <Picker
          label="Effort"
          icon={<Gauge size={13} />}
          text={value.effort ? effortLabel(value.effort) : 'Default effort'}
          value={value.effort}
          options={effortOptions}
          disabled={disabled || loading}
          placement={placement}
          onSelect={(effort) => onChange({ ...value, effort })}
        />
      ) : null}
      <Picker
        label="Permissions"
        icon={value.permissionMode === 'full-access' ? <LockOpen size={13} /> : <Lock size={13} />}
        text={mode.label}
        value={value.permissionMode}
        tone={value.permissionMode === 'full-access' ? 'warning' : undefined}
        options={permissionModes.map((item) => ({ ...item }))}
        disabled={disabled}
        placement={placement}
        onSelect={(selected) => {
          const next = permissionModes.find((item) => item.value === selected)
          if (next) onChange({ ...value, permissionMode: next.value })
        }}
      />
      {catalog.error && !disabled ? (
        <button
          type="button"
          className="icon-button retry-models"
          aria-label="Retry loading models"
          title={catalog.error}
          onClick={() => setReload((count) => count + 1)}
        >
          <RefreshCw size={13} />
        </button>
      ) : null}
    </div>
  )
}
