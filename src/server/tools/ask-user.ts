import { z } from 'zod'
import { defineTool } from './types'

// Multiple-choice questions for the user, shown as the same question card as Claude's own
// AskUserQuestion (Approval.questions) and answered the same way. Claude keeps its built-in tool,
// so this one is for Codex, which otherwise can only ask in plain text and stop.

// 1–4 questions with a few options each. Shared with Claude's AskUserQuestion (claude.ts), so
// both agents' questions are checked the same way before they're shown.
export const questionsSchema = z
  .array(
    z.object({
      question: z.string().trim().min(1).max(1000).describe('The full question, ending with "?".'),
      header: z
        .string()
        .trim()
        .max(100)
        .optional()
        .describe('A very short tag shown above it, e.g. "Auth method".'),
      multiSelect: z.boolean().optional().describe('true when more than one option can be picked.'),
      options: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(200).describe('1–5 words.'),
            description: z
              .string()
              .trim()
              .max(1000)
              .optional()
              .describe('What picking it means, or its trade-off.'),
          }),
        )
        // At least 1, as Claude's AskUserQuestion always allowed; the description asks for 2–4.
        .min(1)
        .max(8)
        .describe('The choices (the user can always type their own answer instead).'),
    }),
  )
  .min(1)
  .max(4)

export const askUser = defineTool({
  name: 'ask_user',
  label: 'Ask the user',
  description:
    'Ask the user one to four multiple-choice questions and wait for their answers, shown as a ' +
    'question card they click through. Use it when you are blocked on a decision that is ' +
    'genuinely theirs to make (which approach, which of several options, what they meant), not ' +
    'for things you can find out from the code or decide with a sensible default. Give 2–4 ' +
    'clear options per question; if you recommend one, put it first and add "(Recommended)" to ' +
    'its label. The user can also type their own answer. Prefer this over ending your turn with ' +
    'a question in plain text.',
  input: {
    questions: questionsSchema.describe('The questions, asked together on one card.'),
  },
  safety: 'safe',
  providers: ['codex'],
  summarize: (input) => input.questions?.[0]?.header || input.questions?.[0]?.question,
  async run(context, input) {
    const answers = await context.ask({
      title:
        input.questions.length === 1
          ? 'A question for you'
          : `${input.questions.length} questions for you`,
      questions: input.questions,
    })
    if (!answers)
      return 'The user skipped these questions. Continue with your best judgment, or ask in plain text if you really need an answer.'
    const lines = input.questions.map(
      (question) => `${question.question}\n→ ${answers[question.question] ?? '(no answer)'}`,
    )
    return `The user answered:\n\n${lines.join('\n\n')}`
  },
})
