import type { ReactNode } from 'react'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Switch } from '@base-ui/react/switch'

// Small shared controls built on Base UI, styled in styles.css (.toggle, .segmented).

// An on/off switch.
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <Switch.Root
      className="toggle"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => onChange(next)}
    >
      <Switch.Thumb className="toggle-thumb" />
    </Switch.Root>
  )
}

// A row of mutually exclusive choices (Light / Dark, Inline / Split…).
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  onOptionClick,
}: {
  label: string
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  // Also runs when the chosen option is clicked again (e.g. to replay a sound).
  onOptionClick?: (value: T) => void
}) {
  return (
    <RadioGroup
      className="segmented"
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className="segmented-option"
          onClick={() => onOptionClick?.(option.value)}
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
