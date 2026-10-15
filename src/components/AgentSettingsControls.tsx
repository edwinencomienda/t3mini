import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Lock, LockOpen, RefreshCw, Terminal } from 'lucide-react'
import {
  effortLabel,
  permissionModes,
  type AgentSettings,
  type ModelCatalog,
} from '../agent-settings'
import type { Provider } from '../types'
import { ProviderIcon } from './ProviderIcon'

type Option = { value: string; label: string; description?: string; badge?: string }
// An extra group of choices shown below the main ones in the same menu.
type Section = {
  label: string
  value: string
  options: Option[]
  onSelect: (value: string) => void
}

// Model lists already loaded this session, so switching threads shows them instantly.
// (The server also caches provider catalogs for five minutes; Retry forces a fresh load.)
const catalogs = new Map<string, ModelCatalog>()

export const providerNames: Record<Provider, string> = { codex: 'Codex', claude: 'Claude' }
export function ProviderMark({ provider, size = 14 }: { provider: Provider; size?: number }) {
  return <ProviderIcon provider={provider} size={size} />
}
// Agent choice for a thread. It can change until the first message; after that the
// provider session belongs to that agent.
export type AgentChoice = {
  installed: Record<Provider, boolean>
  locked: boolean
  // Switches agent; with a model, also selects that model (picked from the other tab).
  onChange: (provider: Provider, model?: string) => void
}

export function Picker({
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
  sections = [],
  variant = 'default',
  trigger,
  header,
  onOpenChange,
}: {
  label: string
  icon?: ReactNode
  text: string
  // 'pill' and 'round' are the composer's soft chip and circle styles.
  variant?: 'default' | 'pill' | 'round'
  // Custom button content instead of icon + text + chevron.
  trigger?: ReactNode
  // Shown above the options (e.g. provider tabs).
  header?: ReactNode
  onOpenChange?: (open: boolean) => void
  value: string
  options: Option[]
  onSelect: (value: string) => void
  disabled?: boolean
  placement: 'up' | 'down'
  tone?: 'warning'
  footer?: ReactNode
  sections?: Section[]
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const openChange = useRef(onOpenChange)
  openChange.current = onOpenChange
  useEffect(() => openChange.current?.(open), [open])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    // Focus the selected option, not header controls like the provider tabs.
    ;(
      list.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      list.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"], button')
    )?.focus()
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
        className={`picker-trigger ${variant} ${tone || ''}`}
        aria-label={`${label}: ${text}`}
        title={variant === 'round' ? `${label}: ${text}` : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {trigger ?? (
          <>
            {icon}
            <span>{text}</span>
            <ChevronDown size={12} className="picker-chevron" />
          </>
        )}
      </button>
      {open ? (
        <div className={`picker-menu ${placement}`} role="menu" aria-label={label} ref={list}>
          {header}
          <div className="picker-heading">{label}</div>
          {[{ label: '', value, options, onSelect }, ...sections].map((section, index) => (
            <div key={section.label || index} role="group" aria-label={section.label || label}>
              {index ? (
                <>
                  <div className="picker-separator" role="separator" />
                  <div className="picker-heading">{section.label}</div>
                </>
              ) : null}
              {section.options.map((option) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === section.value}
                  key={option.value || 'default'}
                  onClick={() => {
                    section.onSelect(option.value)
                    setOpen(false)
                  }}
                >
                  <span className="picker-option-text">
                    <span>
                      {option.label}
                      {option.badge ? <span className="picker-badge">{option.badge}</span> : null}
                    </span>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                  {option.value === section.value ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
          ))}
          {footer}
        </div>
      ) : null}
    </div>
  )
}

// Model list for one provider, shared through the session cache; a request already in flight
// is reused, so two pickers (or both tabs) never load the same list twice.
const inflight = new Map<string, Promise<ModelCatalog>>()
function useCatalog(provider: Provider, cwd: string) {
  const cacheKey = `${provider}|${cwd}`
  const [catalog, setCatalog] = useState<ModelCatalog>(
    () => catalogs.get(cacheKey) ?? { models: [] },
  )
  const [loading, setLoading] = useState(() => !catalogs.has(cacheKey))
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const cached = catalogs.get(cacheKey)
    if (cached && !reload) {
      setCatalog(cached)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setCatalog({ models: [] })
    const timer = setTimeout(() => {
      let request = reload ? undefined : inflight.get(cacheKey)
      if (!request) {
        const params = new URLSearchParams({ provider, cwd, ...(reload ? { refresh: '1' } : {}) })
        request = fetch(`/api/models?${params}`)
          .then(async (response) => {
            if (!response.ok) throw new Error('Could not load models.')
            return (await response.json()) as ModelCatalog
          })
          .then((loaded) => {
            if (!loaded.error) catalogs.set(cacheKey, loaded)
            return loaded
          })
          .catch(() => ({
            models: [],
            error: 'Models unavailable. Use Provider default or retry.',
          }))
          .finally(() => inflight.delete(cacheKey))
        inflight.set(cacheKey, request)
      }
      void request.then((loaded) => {
        if (cancelled) return
        setCatalog(loaded)
        setLoading(false)
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cacheKey, provider, cwd, reload])
  return { catalog, loading, retry: () => setReload((count) => count + 1) }
}

export function AgentSettingsControls({
  provider,
  cwd,
  value,
  onChange,
  disabled = false,
  placement = 'up',
  agent,
}: {
  agent?: AgentChoice
  provider: Provider
  cwd: string
  value: AgentSettings
  onChange: (settings: AgentSettings) => void
  disabled?: boolean
  placement?: 'up' | 'down'
}) {
  // The menu's Claude / Codex tabs. Opening the menu starts on the thread's own agent.
  const [tab, setTab] = useState<Provider>(provider)
  useEffect(() => setTab(provider), [provider])
  const { catalog, loading, retry } = useCatalog(provider, cwd)
  const browsing = useCatalog(tab, cwd)
  const otherTab = tab !== provider
  const model = catalog.models.find((item) => item.id === value.model)
  const mode = permissionModes.find((item) => item.value === value.permissionMode)!
  const efforts = model?.efforts || []
  const tiers = model?.serviceTiers || []
  const tier = tiers.find((item) => item.id === value.serviceTier)
  // The list under the selected tab: this thread's agent, or the other one to switch to.
  const listed = otherTab ? browsing.catalog : catalog
  const listLoading = otherTab ? browsing.loading : loading
  const modelOptions: Option[] = listLoading
    ? []
    : [
        { value: '', label: 'Provider default' },
        ...(!otherTab && value.model && !model ? [{ value: value.model, label: value.model }] : []),
        ...listed.models.map((item) => ({
          value: item.id,
          label: item.label,
          description: item.description,
        })),
      ]
  const canSwitch = Boolean(agent && !agent.locked)
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
  // The pill reads like "Opus 5.5 Medium": the model, then the effort (and a faster tier).
  const effortText = [
    value.effort
      ? effortLabel(value.effort)
      : model?.defaultEffort
        ? effortLabel(model.defaultEffort)
        : '',
    tier?.label ?? '',
  ]
    .filter(Boolean)
    .join(' · ')
  const sections = [
    ...(efforts.length || value.effort
      ? [
          {
            label: 'Effort',
            value: value.effort,
            options: effortOptions,
            onSelect: (effort: string) => onChange({ ...value, effort }),
          },
        ]
      : []),
    // Codex models can offer faster service tiers.
    ...(tiers.length
      ? [
          {
            label: 'Service Tier',
            value: value.serviceTier || '',
            options: [
              { value: '', label: 'Standard', badge: 'Default' },
              ...tiers.map((item) => ({
                value: item.id,
                label: item.label,
                description: item.description,
              })),
            ],
            onSelect: (serviceTier: string) => onChange({ ...value, serviceTier }),
          },
        ]
      : []),
  ]
  return (
    <div className="agent-settings" aria-label="Agent settings" role="group">
      {/* One pill for agent, model, effort, and tier; permissions stay one tap away. */}
      <Picker
        label="Model"
        variant="pill"
        text={[providerNames[provider], modelText, effortText].filter(Boolean).join(' ')}
        trigger={
          <>
            <ProviderMark provider={provider} size={13} />
            <span className="pill-model">{modelText}</span>
            {effortText ? <span className="pill-effort">{effortText}</span> : null}
          </>
        }
        // In the other agent's tab nothing is selected yet.
        value={otherTab ? '\u0000' : value.model}
        options={modelOptions}
        disabled={disabled || loading}
        placement={placement}
        onOpenChange={(open) => {
          if (open) setTab(provider)
        }}
        onSelect={(model) =>
          otherTab
            ? agent?.onChange(tab, model)
            : onChange({ ...value, model, effort: '', serviceTier: '' })
        }
        // Effort and tier belong to this thread's model, so they show on its own tab only.
        sections={otherTab ? [] : sections}
        header={
          agent ? (
            <div className="picker-tabs" role="tablist" aria-label="Agent">
              {(['claude', 'codex'] as const).map((item) => {
                const blocked = item !== provider && !canSwitch
                return (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={tab === item}
                    disabled={blocked}
                    title={
                      blocked
                        ? `Start a new thread to use ${providerNames[item]}.`
                        : !agent.installed[item]
                          ? `${providerNames[item]} CLI not found`
                          : undefined
                    }
                    onClick={() => setTab(item)}
                  >
                    <ProviderMark provider={item} size={12} />
                    {providerNames[item]}
                  </button>
                )
              })}
            </div>
          ) : null
        }
        footer={
          listLoading ? (
            <div className="picker-error">Loading models…</div>
          ) : listed.error ? (
            <div className="picker-error">
              <span>{listed.error}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Retry loading models"
                onClick={() => (otherTab ? browsing.retry() : retry())}
              >
                <RefreshCw size={13} />
              </button>
            </div>
          ) : null
        }
      />
      <Picker
        label="Permissions"
        variant="round"
        text={mode.label}
        trigger={
          value.permissionMode === 'full-access' ? <LockOpen size={14} /> : <Lock size={14} />
        }
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
          onClick={() => retry()}
        >
          <RefreshCw size={13} />
        </button>
      ) : null}
    </div>
  )
}
