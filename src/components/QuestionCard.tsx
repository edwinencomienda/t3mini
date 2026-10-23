import { useEffect, useRef, useState } from 'react'
import { Checkbox } from '@base-ui/react/checkbox'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { MessageCircleQuestion } from 'lucide-react'
import type { Approval, Question } from '../types'

// The agent's multiple-choice questions (Claude's AskUserQuestion, Codex's ask_user), as a slim
// card: the question on one line, then one line per option (its description trailing in grey),
// and "Something else" as a quiet text field at the end. One click (or its number key) answers a
// single-choice question; a multi-select question picks several and goes on with Next / Send.
// Several questions come one at a time ("1 of 3") and are sent together after the last. Several
// picks, or picks plus your own words, are joined with ", ". Answers go back keyed by question.

const own = '\u0000own'
type Choice = { picked: string[]; text: string }
const empty: Choice = { picked: [], text: '' }

export function answer(choice: Choice) {
  const typed = choice.picked.includes(own) ? choice.text.trim() : ''
  return [...choice.picked.filter((value) => value !== own), ...(typed ? [typed] : [])].join(', ')
}
// "Plan A (Recommended)" → a "Recommended" badge instead of the bracketed text.
function splitLabel(label: string) {
  const match = /^(.*?)\s*\(recommended\)\s*$/i.exec(label)
  return match ? { text: match[1]!, recommended: true } : { text: label, recommended: false }
}

function Option({
  multiple,
  number,
  value,
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  multiple: boolean
  number: number
  value: string
  label: string
  description?: string
  checked: boolean
  disabled: boolean
  onToggle: (on: boolean) => void
}) {
  const { text, recommended } = splitLabel(label)
  // The number key is the radio or checkbox itself (Base UI), so it's still a real control.
  const key = multiple ? (
    <Checkbox.Root
      className="question-key"
      checked={checked}
      disabled={disabled}
      onCheckedChange={onToggle}
    >
      {number}
    </Checkbox.Root>
  ) : (
    <Radio.Root className="question-key" value={value} disabled={disabled}>
      {number}
    </Radio.Root>
  )
  return (
    <label
      className={`question-option ${checked ? 'checked' : ''}`}
      title={description}
      // Already picked (you came back to this question): a click confirms it again.
      onClick={checked && !multiple && !disabled ? () => onToggle(true) : undefined}
    >
      {key}
      <span className="question-option-label">
        {text}
        {recommended ? <span className="question-badge">Recommended</span> : null}
      </span>
      {description ? <span className="question-option-desc">{description}</span> : null}
    </label>
  )
}

export function QuestionCard({
  approval,
  disabled,
  onAnswer,
  onSkip,
}: {
  approval: Approval & { questions: Question[] }
  disabled: boolean
  onAnswer: (answers: Record<string, string>) => void
  onSkip: () => void
}) {
  const { questions } = approval
  const [choices, setChoices] = useState<Choice[]>(() => questions.map(() => empty))
  // The question on screen (one at a time).
  const [step, setStep] = useState(0)
  const question = questions[step]!
  const choice = choices[step]!
  const multiple = Boolean(question.multiSelect)
  const last = step === questions.length - 1
  const ready = Boolean(answer(choice))
  const ownInput = useRef<HTMLInputElement>(null)

  // Records this question's choice; `done` goes on to the next question, or sends them all
  // after the last one.
  function update(next: Choice, done = false) {
    const list = choices.map((item, index) => (index === step ? next : item))
    setChoices(list)
    if (!done || disabled || !answer(next)) return
    if (last)
      onAnswer(
        Object.fromEntries(questions.map((item, index) => [item.question, answer(list[index]!)])),
      )
    else setStep(step + 1)
  }
  // Picking an option: a single-choice question is answered at once; multi-select toggles it.
  function pick(value: string, on = true) {
    if (multiple)
      update({
        ...choice,
        picked: on
          ? [...choice.picked.filter((item) => item !== value), value]
          : choice.picked.filter((item) => item !== value),
      })
    else if (value === own) {
      update({ ...choice, picked: [own] })
      ownInput.current?.focus()
    } else update({ ...choice, picked: [value] }, true)
  }

  // Shortcuts while the question is on screen, unless you're typing somewhere (the composer,
  // "Something else"): a number picks that option (the last number is "Something else"), and
  // Enter goes on once a multi-select question has an answer.
  function onKeyDown(event: globalThis.KeyboardEvent) {
    const target = event.target as HTMLElement
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || disabled) return
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.key === 'Enter') {
      if (target.closest('button')) return
      if (ready) {
        event.preventDefault()
        update(choice, true)
      }
      return
    }
    const number = Number(event.key)
    if (!Number.isInteger(number) || number < 1 || number > question.options.length + 1) return
    event.preventDefault()
    const value = number === question.options.length + 1 ? own : question.options[number - 1]!.label
    pick(value, !choice.picked.includes(value))
  }
  const keys = useRef(onKeyDown)
  keys.current = onKeyDown
  useEffect(() => {
    const listen = (event: globalThis.KeyboardEvent) => keys.current(event)
    // Capture phase: runs before the "type anywhere goes to the composer" handler, which then
    // leaves a key used here alone.
    window.addEventListener('keydown', listen, true)
    return () => window.removeEventListener('keydown', listen, true)
  }, [])

  const options = question.options.map((option, index) => (
    <Option
      key={option.label}
      multiple={multiple}
      number={index + 1}
      value={option.label}
      label={option.label}
      description={option.description}
      checked={choice.picked.includes(option.label)}
      disabled={disabled}
      onToggle={(on) => pick(option.label, on)}
    />
  ))
  // "Something else": always there as a quiet field; typing in it picks it.
  const somethingElse = (
    <div
      className={`question-option question-other ${choice.picked.includes(own) ? 'checked' : ''}`}
    >
      <span className="question-key" aria-hidden>
        {question.options.length + 1}
      </span>
      <input
        ref={ownInput}
        className="question-own"
        aria-label="Something else: your own answer"
        placeholder="Something else…"
        maxLength={2000}
        disabled={disabled}
        value={choice.text}
        onChange={(event) => {
          const text = event.target.value
          const picked = multiple
            ? [...choice.picked.filter((item) => item !== own), ...(text.trim() ? [own] : [])]
            : text.trim()
              ? [own]
              : []
          update({ picked, text })
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && choice.text.trim()) {
            event.preventDefault()
            update(choice, true)
          }
        }}
      />
    </div>
  )

  return (
    <section className="question-card" aria-label={approval.title}>
      <div className="question-head">
        <MessageCircleQuestion size={14} className="question-icon" aria-hidden />
        <span className="question-text" id={`${approval.id}-q`}>
          {question.question}
          {question.header ? <span className="question-topic">{question.header}</span> : null}
        </span>
        <span className="question-actions">
          {questions.length > 1 ? (
            <span className="question-count">
              {step + 1} of {questions.length}
            </span>
          ) : null}
          {step > 0 ? (
            <button type="button" className="question-link" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : null}
          <button type="button" className="question-link" disabled={disabled} onClick={onSkip}>
            Skip
          </button>
        </span>
      </div>
      {multiple ? (
        <div className="question-options" role="group" aria-labelledby={`${approval.id}-q`}>
          {options}
          {somethingElse}
        </div>
      ) : (
        <RadioGroup
          className="question-options"
          aria-labelledby={`${approval.id}-q`}
          value={choice.picked[0] === own ? '' : (choice.picked[0] ?? '')}
          onValueChange={(value) => pick(String(value))}
        >
          {options}
          {somethingElse}
        </RadioGroup>
      )}
      {multiple ? (
        <div className="question-next">
          <span>Pick as many as you like</span>
          <button
            type="button"
            className="primary"
            disabled={disabled || !ready}
            onClick={() => update(choice, true)}
          >
            {last ? 'Send' : 'Next'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
