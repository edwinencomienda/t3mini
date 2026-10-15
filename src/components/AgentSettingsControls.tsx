import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Lock,
  LockOpen,
  RefreshCw,
} from 'lucide-react'
import {
  effortLabel,
  permissionModes,
  type AgentSettings,
  type ModelCatalog,
} from '../agent-settings'
import type { Provider } from '../types'
import { ProviderIcon } from './ProviderIcon'

type Option = { value: string; label: string; description?: string; badge?: string }
// One setting in a DrillMenu: a row on the main view that opens its own list of choices.
type MenuRow = {
  key: string
  label: string
  // The current choice, shown on the right of the row.
  text: string
  value: string
  options: Option[]
  onSelect: (value: string) => void
  // Close the menu after a pick instead of going back to the main view.
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
          {options.map((option) => (
            <OptionButton
              key={option.value}
              option={option}
              checked={option.value === value}
              onClick={() => {
                onSelect(option.value)
                setOpen(false)
              }}
            />
          ))}
          {footer}
        </div>
      ) : null}
    </div>
  )
}

function OptionButton({
  option,
  checked,
  disabled,
  onClick,
}: {
  option: Option
  checked: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="picker-option-text">
        <span>
          {option.label}
          {option.badge ? <span className="picker-badge">{option.badge}</span> : null}
        </span>
        {option.description ? <small>{option.description}</small> : null}
      </span>
      {checked ? <Check size={14} /> : null}
    </button>
  )
}

// A menu of settings rows (Model, Effort…). Hovering or clicking a row opens its choices in a
// submenu beside the menu (on top of it, with a back button, when there's no room beside it).
// Picking a choice closes the submenu but keeps the menu open, so the next setting is one hover
// away.
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
  // The row whose submenu is open; focus moves into it when opened by click or keyboard.
  const [active, setActive] = useState<{ key: string; focus: boolean }>()
  const [position, setPosition] = useState<{
    key: string
    top: number
    left: number
    // No room beside the menu (phones): the submenu covers it instead.
    overlay?: { width: number }
  }>()
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const submenu = useRef<HTMLDivElement>(null)
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined)
  const openChange = useRef(onOpenChange)
  openChange.current = onOpenChange
  const row = open ? rows.find((item) => item.key === active?.key) : undefined
  const placed = position?.key === row?.key ? position : undefined
  const rowButton = (key?: string) =>
    menu.current?.querySelector<HTMLButtonElement>(`[data-row="${key}"]`)
  useEffect(() => {
    openChange.current?.(open)
    if (!open) setActive(undefined)
    else rowButton(rows[0]?.key)?.focus()
    // Only on open/close; rows change while the menu is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      clearTimeout(hover.current)
    }
  }, [open])
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  // Place the submenu next to its row, kept inside the window.
  useLayoutEffect(() => {
    const item = rowButton(row?.key),
      panel = menu.current,
      sub = submenu.current,
      box = root.current?.getBoundingClientRect()
    if (!row || !item || !panel || !sub || !box) return
    const margin = 8,
      gap = 4
    const bounds = panel.getBoundingClientRect(),
      size = sub.getBoundingClientRect()
    const left =
      bounds.right + gap + size.width <= window.innerWidth - margin
        ? bounds.right + gap
        : bounds.left - gap - size.width >= margin
          ? bounds.left - gap - size.width
          : undefined
    // Line the first choice up with the row (the submenu has a little padding on top).
    const top = Math.max(
      margin,
      Math.min(
        left === undefined ? bounds.top : item.getBoundingClientRect().top - 5,
        window.innerHeight - margin - size.height,
      ),
    )
    setPosition({
      key: row.key,
      top: top - box.top,
      left: (left ?? bounds.left) - box.left,
      ...(left === undefined ? { overlay: { width: bounds.width } } : {}),
    })
  }, [row?.key, row?.options.length, Boolean(row?.footer)])
  useEffect(() => {
    if (!placed || !active?.focus) return
    ;(
      submenu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      submenu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
    )?.focus()
  }, [placed, active])
  const back = () => {
    const key = row?.key
    setActive(undefined)
    rowButton(key)?.focus()
  }
  function keys(event: React.KeyboardEvent) {
    const focused = document.activeElement as HTMLElement
    const inSubmenu = Boolean(submenu.current?.contains(focused))
    const items = [
      ...((inSubmenu ? submenu : menu).current?.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)',
      ) || []),
    ]
    const index = items.indexOf(focused as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (row) back()
      else {
        setOpen(false)
        root.current?.querySelector<HTMLButtonElement>('.picker-trigger')?.focus()
      }
    } else if (event.key === 'ArrowLeft' && inSubmenu) {
      event.preventDefault()
      back()
    } else if (event.key === 'ArrowRight' && !inSubmenu && focused.dataset.row) {
      event.preventDefault()
      setActive({ key: focused.dataset.row, focus: true })
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(index + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Tab') setOpen(false)
  }
  return (
    <div className="picker" ref={root} onKeyDown={open ? keys : undefined}>
      <button
        type="button"
        className="picker-trigger pill"
        aria-label={`${label}: ${text}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open ? (
        <div
          className={`picker-menu settings ${placement}`}
          role="menu"
          aria-label={label}
          ref={menu}
        >
          {header}
          {rows.map((item) => (
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={row?.key === item.key}
              className="picker-row"
              data-row={item.key}
              key={item.key}
              onPointerEnter={(event) => {
                // Touch taps also fire pointerenter; those open on click instead.
                if (event.pointerType !== 'mouse') return
                event.currentTarget.focus({ preventScroll: true })
                clearTimeout(hover.current)
                if (row?.key === item.key) return
                // Swapping an open submenu waits a moment, so heading diagonally into it
                // across another row doesn't replace it.
                hover.current = setTimeout(
                  () => setActive({ key: item.key, focus: false }),
                  row ? 150 : 0,
                )
              }}
              onPointerLeave={() => clearTimeout(hover.current)}
              onClick={() => {
                clearTimeout(hover.current)
                setActive({ key: item.key, focus: true })
              }}
            >
              <span className="picker-row-label">{item.label}</span>
              <span className="picker-row-value">{item.text}</span>
              <ChevronRight size={14} />
            </button>
          ))}
          {note}
        </div>
      ) : null}
      {row ? (
        <div
          className="picker-menu picker-submenu"
          role="menu"
          aria-label={row.label}
          ref={submenu}
          style={{
            top: placed?.top ?? 0,
            left: placed?.left ?? 0,
            minWidth: placed?.overlay?.width,
            visibility: placed ? undefined : 'hidden',
          }}
          onPointerEnter={() => clearTimeout(hover.current)}
        >
          {placed?.overlay ? (
            <button
              type="button"
              className="picker-back"
              aria-label={`Back to ${label.toLowerCase()} settings`}
              onClick={back}
            >
              <ChevronLeft size={14} />
              {row.label}
            </button>
          ) : (
            <div className="picker-heading">{row.label}</div>
          )}
          {row.options.map((option) => (
            <OptionButton
              key={option.value}
              option={option}
              checked={option.value === row.value}
              disabled={busy}
              onClick={() => {
                row.onSelect(option.value)
                if (row.closeOnSelect) setOpen(false)
                else back()
              }}
            />
          ))}
          {row.footer}
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
    text: otherTab ? 'Choose' : modelText,
    // In the other agent's tab nothing is selected yet.
    value: otherTab ? '\u0000' : value.model,
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
                onSelect: (effort: string) => onChange({ ...value, effort }),
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
        disabled={disabled || loading}
        busy={busy}
        placement={placement}
        onOpenChange={(open) => {
          if (open) setTab(provider)
        }}
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
