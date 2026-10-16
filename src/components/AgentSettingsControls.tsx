import { useEffect, useState, type ReactNode } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Tabs } from '@base-ui/react/tabs'
import { Check, ChevronDown, ChevronRight, Lock, LockOpen, RefreshCw } from 'lucide-react'
import {
  effortLabel,
  permissionModes,
  type AgentSettings,
  type ModelCatalog,
} from '../agent-settings'
import type { Provider } from '../types'
import { loadPreferences } from '../preferences'
import { ProviderIcon } from './ProviderIcon'

type Option = { value: string; label: string; description?: string; badge?: string }
// One setting in the model menu: a row that opens its choices in a submenu.
type MenuRow = {
  key: string
  label: string
  // The current choice, shown on the right of the row.
  text: string
  value: string
  options: Option[]
  onSelect: (value: string) => void
  // Close the whole menu after a pick instead of just the submenu.
  closeOnSelect?: boolean
  // Shown under the choices, e.g. loading or a retry button.
  footer?: ReactNode
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

// The menus open above the composer (or below a field) and stay inside the window; Base UI
// handles focus, keyboard navigation, dismissal, and flipping when there's no room.
const positioner = (placement: 'up' | 'down') =>
  ({
    side: placement === 'up' ? 'top' : 'bottom',
    align: 'start',
    sideOffset: 6,
    collisionPadding: 8,
  }) as const

// A labelled list of choices with a check on the selected one.
function OptionList({
  label,
  value,
  options,
  onSelect,
  closeOnClick,
  disabled,
}: {
  label: string
  value: string
  options: Option[]
  onSelect: (value: string) => void
  closeOnClick?: boolean
  disabled?: boolean
}) {
  return (
    <Menu.RadioGroup
      value={value}
      onValueChange={(next: string) => onSelect(next)}
      disabled={disabled}
    >
      <Menu.GroupLabel className="picker-heading">{label}</Menu.GroupLabel>
      {options.map((option) => (
        <Menu.RadioItem
          key={option.value}
          value={option.value}
          label={option.label}
          closeOnClick={closeOnClick}
        >
          <span className="picker-option-text">
            <span>
              {option.label}
              {option.badge ? <span className="picker-badge">{option.badge}</span> : null}
            </span>
            {option.description ? <small>{option.description}</small> : null}
          </span>
          <Menu.RadioItemIndicator className="picker-check">
            <Check size={14} />
          </Menu.RadioItemIndicator>
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  )
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
  action,
  variant = 'default',
  trigger,
}: {
  label: string
  icon?: ReactNode
  text: string
  // 'pill' and 'round' are the composer's soft chip and circle styles.
  variant?: 'default' | 'pill' | 'round'
  // Custom button content instead of icon + text + chevron.
  trigger?: ReactNode
  value: string
  options: Option[]
  onSelect: (value: string) => void
  disabled?: boolean
  placement: 'up' | 'down'
  tone?: 'warning'
  // An extra item under the choices, e.g. "Add project…".
  action?: { label: string; icon: ReactNode; onSelect: () => void }
}) {
  return (
    <Menu.Root disabled={disabled}>
      <Menu.Trigger
        className={`picker-trigger ${variant} ${tone || ''}`}
        aria-label={`${label}: ${text}`}
        title={variant === 'round' ? `${label}: ${text}` : undefined}
      >
        {trigger ?? (
          <>
            {icon}
            <span>{text}</span>
            <ChevronDown size={12} className="picker-chevron" />
          </>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="picker-positioner" {...positioner(placement)}>
          <Menu.Popup className="picker-menu" aria-label={label}>
            <OptionList
              label={label}
              value={value}
              options={options}
              onSelect={onSelect}
              closeOnClick
            />
            {action ? (
              <Menu.Item className="picker-footer-action" onClick={action.onSelect}>
                {action.icon}
                {action.label}
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

// The model menu: rows for Model, Effort… that open their choices in a submenu on hover or
// click. Picking a choice closes the submenu but keeps the menu open, so the next setting is
// one hover away.
function SettingsMenu({
  label,
  text,
  trigger,
  header,
  note,
  rows,
  disabled,
  busy,
  placement,
  onOpenChange,
}: {
  label: string
  text: string
  trigger: ReactNode
  // Shown above the rows (e.g. provider tabs).
  header?: ReactNode
  // Shown below the rows.
  note?: ReactNode
  rows: MenuRow[]
  disabled?: boolean
  // A pick is still saving: choices are disabled, but the menu stays open.
  busy?: boolean
  placement: 'up' | 'down'
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<string | null>(null)
  const change = (next: boolean) => {
    setOpen(next)
    if (!next) setSubmenu(null)
    onOpenChange?.(next)
  }
  useEffect(() => {
    // An agent started working: close, like the other controls.
    if (disabled) change(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])
  return (
    <Menu.Root open={open} onOpenChange={change} disabled={disabled}>
      <Menu.Trigger className="picker-trigger pill" aria-label={`${label}: ${text}`}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="picker-positioner" {...positioner(placement)}>
          <Menu.Popup className="picker-menu settings" aria-label={label}>
            {header}
            {rows.map((row) => (
              <Menu.SubmenuRoot
                key={row.key}
                open={submenu === row.key}
                onOpenChange={(next) =>
                  setSubmenu((current) => (next ? row.key : current === row.key ? null : current))
                }
              >
                <Menu.SubmenuTrigger className="picker-row" label={row.label} openOnHover>
                  <span className="picker-row-label">{row.label}</span>
                  <span className="picker-row-value">{row.text}</span>
                  <ChevronRight size={14} />
                </Menu.SubmenuTrigger>
                <Menu.Portal>
                  <Menu.Positioner
                    className="picker-positioner"
                    sideOffset={4}
                    alignOffset={-5}
                    collisionPadding={8}
                  >
                    <Menu.Popup className="picker-menu picker-submenu" aria-label={row.label}>
                      <OptionList
                        label={row.label}
                        value={row.value}
                        options={row.options}
                        disabled={busy}
                        onSelect={(value) => {
                          row.onSelect(value)
                          if (row.closeOnSelect) change(false)
                          else setSubmenu(null)
                        }}
                      />
                      {row.footer}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.SubmenuRoot>
            ))}
            {note}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
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
  busy = false,
  placement = 'up',
  agent,
}: {
  agent?: AgentChoice
  // Settings are saving: the menus stay open but choices wait.
  busy?: boolean
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
  // With Provider default, effort and tier choices come from the model the provider picks.
  const effective =
    model ??
    (value.model
      ? undefined
      : catalog.models.find((item) => item.isDefault || item.id === 'default'))
  const mode = permissionModes.find((item) => item.value === value.permissionMode)!
  const efforts = effective?.efforts || []
  const tiers = effective?.serviceTiers || []
  const tier = tiers.find((item) => item.id === value.serviceTier)
  // The list under the selected tab: this thread's agent, or the other one to switch to.
  const listed = otherTab ? browsing.catalog : catalog
  // The other agent's tab (while the switch saves, or when its CLI is missing) shows your last
  // choices for that agent, which a switch reuses.
  const remembered = otherTab ? loadPreferences().settings[tab] : undefined
  const rememberedModel = remembered
    ? browsing.catalog.models.find((item) => item.id === remembered.model)
    : undefined
  const rememberedText = remembered
    ? [
        rememberedModel?.label || remembered.model || 'Provider default',
        remembered.effort ? effortLabel(remembered.effort) : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Choose'
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
      label: effective?.defaultEffort
        ? `Default (${effortLabel(effective.defaultEffort)})`
        : 'Default',
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
      : effective?.defaultEffort
        ? effortLabel(effective.defaultEffort)
        : '',
    tier?.label ?? '',
  ]
    .filter(Boolean)
    .join(' · ')
  const modelRow: MenuRow = {
    key: 'model',
    label: 'Model',
    text: otherTab ? rememberedText : modelText,
    // In the other agent's tab: your last model there, else nothing selected yet.
    value: otherTab ? (remembered ? remembered.model : '\u0000') : value.model,
    options: modelOptions,
    // Picking from the other agent's tab switches the thread to that agent.
    onSelect: (model) =>
      otherTab
        ? agent?.onChange(tab, model)
        : onChange({ ...value, model, effort: '', serviceTier: '' }),
    closeOnSelect: otherTab,
    footer: listLoading ? (
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
    ) : null,
  }
  // Effort and tier belong to this thread's model, so they show on its own tab only.
  const rows: MenuRow[] = otherTab
    ? [modelRow]
    : [
        modelRow,
        ...(efforts.length || value.effort
          ? [
              {
                key: 'effort',
                label: 'Effort',
                text: effortOptions.find((item) => item.value === value.effort)?.label ?? 'Default',
                value: value.effort,
                options: effortOptions,
                // The server needs a model for an effort, so with Provider default this
                // selects the default model whose levels are listed.
                onSelect: (effort: string) =>
                  onChange({
                    ...value,
                    model: value.model || (effort ? (effective?.id ?? '') : ''),
                    effort,
                  }),
              },
            ]
          : []),
        // Codex models can offer faster service tiers.
        ...(tiers.length
          ? [
              {
                key: 'tier',
                label: 'Service tier',
                text: tier?.label ?? 'Standard',
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
      <SettingsMenu
        label="Model"
        text={[providerNames[provider], modelText, effortText].filter(Boolean).join(' ')}
        trigger={
          <>
            <ProviderMark provider={provider} size={13} />
            <span className="pill-model">{modelText}</span>
            {effortText ? <span className="pill-effort">{effortText}</span> : null}
          </>
        }
        rows={rows}
        disabled={disabled}
        busy={busy}
        placement={placement}
        onOpenChange={(open) => {
          if (open) setTab(provider)
        }}
        header={
          agent ? (
            <Tabs.Root
              value={tab}
              onValueChange={(next: Provider) => {
                setTab(next)
                // Picking the other agent's tab switches to it right away, with your last
                // model and effort for that agent. (Without its CLI you can only browse.)
                if (next !== provider && canSwitch && agent.installed[next]) agent.onChange(next)
              }}
            >
              <Tabs.List className="picker-tabs" aria-label="Agent">
                {(['claude', 'codex'] as const).map((item) => {
                  const blocked = item !== provider && !canSwitch
                  return (
                    <Tabs.Tab
                      key={item}
                      value={item}
                      disabled={blocked}
                      title={
                        blocked
                          ? `Start a new thread to use ${providerNames[item]}.`
                          : !agent.installed[item]
                            ? `${providerNames[item]} CLI not found`
                            : undefined
                      }
                    >
                      <ProviderMark provider={item} size={12} />
                      {providerNames[item]}
                    </Tabs.Tab>
                  )
                })}
              </Tabs.List>
            </Tabs.Root>
          ) : null
        }
        note={
          otherTab ? (
            <div className="picker-note">
              Picking a model switches this thread to {providerNames[tab]}.
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
        disabled={disabled || busy}
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
