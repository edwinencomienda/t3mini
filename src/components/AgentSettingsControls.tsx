import { useEffect, useState, type ReactNode } from 'react'
import { apiBaseFor, parseRemote } from '../hub'
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
export type MenuRow = {
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
// Agent choice for a thread. Picking the other agent's tab switches right away, with your last
// settings for it; in a started thread the new agent gets a recap of the conversation (see
// server/handoff.ts).
export type AgentChoice = {
  installed: Record<Provider, boolean>
  // Switches agent: with your last settings for it, or the ones picked in its tab.
  onChange: (provider: Provider, settings?: AgentSettings) => void
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
export function SettingsMenu({
  label,
  text,
  trigger,
  triggerClassName = 'picker-trigger pill',
  title,
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
  triggerClassName?: string
  title?: string
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
      <Menu.Trigger className={triggerClassName} title={title} aria-label={`${label}: ${text}`}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="picker-positioner" {...positioner(placement)}>
          <Menu.Popup
            className={`picker-menu settings${header ? ' with-tabs' : ''}`}
            aria-label={label}
          >
            {header}
            {/* With agent tabs, the rows keep one height for either agent (styles.css), so the
                menu, which opens upward, doesn't jump when a switch adds or drops a row. */}
            <div className="picker-rows">
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
            </div>
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
  // Kept per key: when the agent or folder changes, a list already loaded shows in the same
  // render (no empty or loading frame in between).
  const [state, setState] = useState(() => ({
    key: cacheKey,
    catalog: catalogs.get(cacheKey) ?? { models: [] },
    loading: !catalogs.has(cacheKey),
  }))
  const [reload, setReload] = useState(0)
  const cached = catalogs.get(cacheKey)
  const current =
    state.key === cacheKey
      ? state
      : { key: cacheKey, catalog: cached ?? { models: [] }, loading: !cached }
  useEffect(() => {
    const cached = catalogs.get(cacheKey)
    if (cached && !reload) {
      setState({ key: cacheKey, catalog: cached, loading: false })
      return
    }
    let cancelled = false
    setState({ key: cacheKey, catalog: { models: [] }, loading: true })
    const timer = setTimeout(() => {
      let request = reload ? undefined : inflight.get(cacheKey)
      if (!request) {
        // A machine's thread (the hub): its models come from that machine's agents, for its
        // own folder.
        const remote = parseRemote(cwd)
        const params = new URLSearchParams({
          provider,
          cwd: remote ? remote.id : cwd,
          ...(reload ? { refresh: '1' } : {}),
        })
        request = fetch(`${apiBaseFor(cwd)}/models?${params}`)
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
        setState({ key: cacheKey, catalog: loaded, loading: false })
      })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cacheKey, provider, cwd, reload])
  return {
    catalog: current.catalog,
    loading: current.loading,
    retry: () => setReload((count) => count + 1),
  }
}

// The rows for one agent's settings: Model, then Effort and (Codex) Service tier for that
// model. With Provider default, effort and tier choices come from the model the agent picks.
function settingRows({
  current,
  catalog,
  loading,
  retry,
  apply,
}: {
  current: AgentSettings
  catalog: ModelCatalog
  loading: boolean
  retry: () => void
  apply: (settings: AgentSettings) => void
}) {
  const model = catalog.models.find((item) => item.id === current.model)
  const effective =
    model ??
    (current.model
      ? undefined
      : catalog.models.find((item) => item.isDefault || item.id === 'default'))
  const efforts = effective?.efforts || []
  const tiers = effective?.serviceTiers || []
  const tier = tiers.find((item) => item.id === current.serviceTier)
  const modelOptions: Option[] = loading
    ? []
    : [
        { value: '', label: 'Provider default' },
        ...(current.model && !model ? [{ value: current.model, label: current.model }] : []),
        ...catalog.models.map((item) => ({
          value: item.id,
          label: item.label,
          description: item.description,
        })),
      ]
  const effortOptions: Option[] = [
    {
      value: '',
      label: effective?.defaultEffort
        ? `Default (${effortLabel(effective.defaultEffort)})`
        : 'Default',
    },
    ...(current.effort && !efforts.includes(current.effort)
      ? [{ value: current.effort, label: effortLabel(current.effort) }]
      : []),
    ...efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
  ]
  const modelText = loading
    ? current.model
      ? current.model
      : 'Loading…'
    : model?.label || current.model || 'Default model'
  // The pill reads like "Opus 5.5 Medium": the model, then the effort (and a faster tier).
  const effortText = [
    current.effort
      ? effortLabel(current.effort)
      : effective?.defaultEffort
        ? effortLabel(effective.defaultEffort)
        : '',
    tier?.label ?? '',
  ]
    .filter(Boolean)
    .join(' · ')
  const rows: MenuRow[] = [
    {
      key: 'model',
      label: 'Model',
      text: modelText,
      value: current.model,
      options: modelOptions,
      onSelect: (model) => apply({ ...current, model, effort: '', serviceTier: '' }),
      footer: loading ? (
        <div className="picker-error">Loading models…</div>
      ) : catalog.error ? (
        <div className="picker-error">
          <span>{catalog.error}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Retry loading models"
            onClick={retry}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      ) : null,
    },
    ...(efforts.length || current.effort
      ? [
          {
            key: 'effort',
            label: 'Effort',
            text: effortOptions.find((item) => item.value === current.effort)?.label ?? 'Default',
            value: current.effort,
            options: effortOptions,
            // The server needs a model for an effort, so with Provider default this selects
            // the default model whose levels are listed.
            onSelect: (effort: string) =>
              apply({
                ...current,
                model: current.model || (effort ? (effective?.id ?? '') : ''),
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
            value: current.serviceTier || '',
            options: [
              { value: '', label: 'Standard', badge: 'Default' },
              ...tiers.map((item) => ({
                value: item.id,
                label: item.label,
                description: item.description,
              })),
            ],
            onSelect: (serviceTier: string) => apply({ ...current, serviceTier }),
          },
        ]
      : []),
  ]
  return { rows, modelText, effortText }
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
  // Both agents' model lists load with the composer, so switching tabs or agents shows the
  // other list at once instead of loading it then.
  const lists = { claude: useCatalog('claude', cwd), codex: useCatalog('codex', cwd) }
  const { catalog, loading, retry } = lists[provider]
  const browsing = lists[tab]
  const otherTab = tab !== provider
  const mode = permissionModes.find((item) => item.value === value.permissionMode)!
  // This thread's agent: its settings, applied as you pick.
  const own = settingRows({
    current: value,
    catalog,
    loading,
    retry,
    apply: onChange,
  })
  // The other agent's tab starts from your last choices for it (or its defaults); any pick
  // there (model, effort, or tier) switches the thread to that agent with those settings.
  const pending: AgentSettings = (otherTab && loadPreferences().settings[tab]) || {
    model: '',
    effort: '',
    serviceTier: '',
    permissionMode: value.permissionMode,
  }
  const other = otherTab
    ? settingRows({
        current: pending,
        catalog: browsing.catalog,
        loading: browsing.loading,
        retry: browsing.retry,
        apply: (settings) => agent?.onChange(tab, settings),
      })
    : undefined
  const rows = other ? other.rows : own.rows
  const { modelText, effortText } = own
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
                // model and effort for that agent; the menu stays open on its settings.
                // (Without its CLI you can only browse.)
                if (next !== provider && agent.installed[next]) agent.onChange(next)
              }}
            >
              <Tabs.List className="picker-tabs" aria-label="Agent">
                {(['claude', 'codex'] as const).map((item) => {
                  return (
                    <Tabs.Tab
                      key={item}
                      value={item}
                      title={
                        !agent.installed[item] ? `${providerNames[item]} CLI not found` : undefined
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
        // The other agent's tab only stays open when its CLI is missing (a click switches
        // otherwise), so that's the only note.
        note={
          otherTab && agent && !agent.installed[tab] ? (
            <div className="picker-note">{providerNames[tab]} CLI not found.</div>
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
