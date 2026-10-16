import { useState } from 'react'
import { Checkbox } from '@base-ui/react/checkbox'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Check, MessageCircleQuestion } from 'lucide-react'
import type { Approval, Question } from '../types'

// The agent's multiple-choice questions (Claude's AskUserQuestion): pick an option per question
// (several when it allows that) or type your own answer. Answers go back keyed by question text;
// several picks, or picks plus your own words, are joined with ", ".

const own = '\u0000own'
type Choice = { picked: string[]; text: string }

function answer(choice: Choice) {
  const typed = choice.picked.includes(own) ? choice.text.trim() : ''
  return [...choice.picked.filter((value) => value !== own), ...(typed ? [typed] : [])].join(', ')
}

function Option({
  multiple,
  value,
  label,
  description,
  checked,
  onToggle,
}: {
  multiple?: boolean
  value: string
  label: string
  description?: string
  checked: boolean
  onToggle: (on: boolean) => void
}) {
  return (
    <label className={`question-option ${checked ? 'checked' : ''}`}>
      {multiple ? (
        <Checkbox.Root className="question-check" checked={checked} onCheckedChange={onToggle}>
          <Checkbox.Indicator className="question-check-indicator">
            <Check size={11} strokeWidth={3} />
          </Checkbox.Indicator>
        </Checkbox.Root>
      ) : (
        <Radio.Root className="question-radio" value={value}>
          <Radio.Indicator className="question-radio-dot" />
        </Radio.Root>
      )}
      <span className="question-option-text">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
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
      {question.options.map((option) => (
        <Option
          key={option.label}
          multiple={multiple}
          value={option.label}
          label={option.label}
          description={option.description}
          checked={choice.picked.includes(option.label)}
          onToggle={(on) => toggle(option.label, on)}
        />
      ))}
      <Option
        multiple={multiple}
        value={own}
        label="Something else"
        checked={choice.picked.includes(own)}
        onToggle={(on) => toggle(own, on)}
      />
    </>
  )
  return (
    <fieldset className="question">
      <legend>
        {question.header ? <span className="question-header">{question.header}</span> : null}
        {question.question}
      </legend>
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
  return (
    <section className="approval question-card">
      <div className="approval-title">
        <MessageCircleQuestion size={16} />
        <strong>{approval.title}</strong>
      </div>
      <form
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
            onChange={(choice) =>
              setChoices((list) => list.map((item, n) => (n === index ? choice : item)))
            }
          />
        ))}
        <div className="approval-actions">
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
