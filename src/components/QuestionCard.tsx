import { useEffect, useRef, useState } from 'react'
import { Checkbox } from '@base-ui/react/checkbox'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { MessageCircleQuestion } from 'lucide-react'
import type { Approval, Question } from '../types'

// The agent's multiple-choice questions (Claude's AskUserQuestion), as one calm card: each
// question with its options in a single list, numbered so 1–9 picks one (Enter sends), or
// "Something else" to type your own answer. Several picks (multi-select), or picks plus your own
// words, are joined with ", ". Answers go back keyed by question text.

const own = '\u0000own'
type Choice = { picked: string[]; text: string }

function answer(choice: Choice) {
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
  onToggle,
  children,
}: {
  multiple?: boolean
  number: number
  value: string
  label: string
  description?: string
  checked: boolean
  onToggle: (on: boolean) => void
  children?: React.ReactNode
}) {
  const { text, recommended } = splitLabel(label)
  // The number key is the radio or checkbox itself (Base UI), so it's still a real control.
  const key = multiple ? (
    <Checkbox.Root className="question-key" checked={checked} onCheckedChange={onToggle}>
      {number}
    </Checkbox.Root>
  ) : (
    <Radio.Root className="question-key" value={value}>
      {number}
    </Radio.Root>
  )
  return (
    <label className={`question-option ${checked ? 'checked' : ''}`}>
      {key}
      <span className="question-option-text">
        <span className="question-option-label">
          {text}
          {recommended ? <span className="question-badge">Recommended</span> : null}
        </span>
        {description ? <small>{description}</small> : null}
        {children}
      </span>
    </label>
  )
}

function QuestionField({
  question,
  choice,
  onChange,
}: {
  question: Question
  choice: Choice
  onChange: (choice: Choice) => void
}) {
  const multiple = Boolean(question.multiSelect)
  const toggle = (value: string, on: boolean) =>
    onChange({
      ...choice,
      picked: multiple
        ? on
          ? [...choice.picked, value]
          : choice.picked.filter((item) => item !== value)
        : [value],
    })
  const options = (
    <>
      {question.options.map((option, index) => (
        <Option
          key={option.label}
          multiple={multiple}
          number={index + 1}
          value={option.label}
          label={option.label}
          description={option.description}
          checked={choice.picked.includes(option.label)}
          onToggle={(on) => toggle(option.label, on)}
        />
      ))}
      <Option
        multiple={multiple}
        number={question.options.length + 1}
        value={own}
        label="Something else"
        checked={choice.picked.includes(own)}
        onToggle={(on) => toggle(own, on)}
      >
        {choice.picked.includes(own) ? (
          <input
            className="question-own"
            aria-label="Your answer"
            placeholder="Type your answer"
            autoFocus
            maxLength={2000}
            value={choice.text}
            onChange={(event) => onChange({ ...choice, text: event.target.value })}
          />
        ) : null}
      </Option>
    </>
  )
  return (
    <fieldset className="question">
      <legend className="question-text">{question.question}</legend>
      {multiple ? (
        <div className="question-options" role="group" aria-label={question.question}>
          {options}
        </div>
      ) : (
        <RadioGroup
          className="question-options"
          aria-label={question.question}
          value={choice.picked[0] ?? ''}
          onValueChange={(value) => toggle(String(value), true)}
        >
          {options}
        </RadioGroup>
      )}
      {multiple ? <p className="question-hint">Pick as many as you like.</p> : null}
    </fieldset>
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
  const [choices, setChoices] = useState<Choice[]>(() =>
    questions.map(() => ({ picked: [], text: '' })),
  )
  const answers = Object.fromEntries(
    questions.map((question, index) => [question.question, answer(choices[index]!)]),
  )
  const ready = Object.values(answers).every(Boolean)
  const setChoice = (index: number, choice: Choice) =>
    setChoices((list) => list.map((item, n) => (n === index ? choice : item)))
  const form = useRef<HTMLFormElement>(null)
  // Shortcuts while the question is on screen, unless you're typing somewhere (the composer,
  // "Something else"): a number picks an option of the question you're in (else the first one
  // still open), and Enter sends once every question has an answer.
  function onKeyDown(event: globalThis.KeyboardEvent) {
    const target = event.target as HTMLElement
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.key === 'Enter') {
      if (target.closest('button')) return
      if (ready && !disabled) {
        event.preventDefault()
        onAnswer(answers)
      }
      return
    }
    const number = Number(event.key)
    if (!Number.isInteger(number) || number < 1 || disabled) return
    const fieldsets = [...(form.current?.querySelectorAll('fieldset') ?? [])]
    const inside = fieldsets.findIndex((fieldset) => fieldset.contains(target))
    const index =
      inside >= 0
        ? inside
        : Math.max(
            0,
            questions.findIndex((_, n) => !answer(choices[n]!)),
          )
    const question = questions[index]
    if (!question || number > question.options.length + 1) return
    event.preventDefault()
    const value = number === question.options.length + 1 ? own : question.options[number - 1]!.label
    const choice = choices[index]!
    setChoice(index, {
      ...choice,
      picked: question.multiSelect
        ? choice.picked.includes(value)
          ? choice.picked.filter((item) => item !== value)
          : [...choice.picked, value]
        : [value],
    })
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
  const headers = questions.map((question) => question.header).filter(Boolean)
  return (
    <section className="question-card" aria-label={approval.title}>
      <div className="question-eyebrow">
        <MessageCircleQuestion size={14} />
        <span>{approval.title}</span>
        {headers.length === 1 ? <span className="question-topic">{headers[0]}</span> : null}
      </div>
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault()
          if (ready && !disabled) onAnswer(answers)
        }}
      >
        {questions.map((question, index) => (
          <QuestionField
            key={question.question}
            question={question}
            choice={choices[index]!}
            onChange={(choice) => setChoice(index, choice)}
          />
        ))}
        <div className="question-footer">
          <span className="question-keys">
            Press a number to choose{ready ? ', Enter to send' : ''}
          </span>
          <button type="button" className="secondary" disabled={disabled} onClick={onSkip}>
            Skip
          </button>
          <button type="submit" className="primary" disabled={disabled || !ready}>
            {questions.length === 1 ? 'Send answer' : 'Send answers'}
          </button>
        </div>
      </form>
    </section>
  )
}
