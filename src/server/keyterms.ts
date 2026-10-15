import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Dictation vocabulary from the thread: the unusual words in the agent's last replies (names,
// code identifiers, jargon) that speech recognition tends to mangle, sent to Deepgram as
// keyterms. Ordinary English words are left out, since Deepgram already gets those right.
//
// These words leave the machine, so the filter is strict: code blocks, links, and email
// addresses are dropped first, and only short word-like tokens survive. Anything that could be
// a key or token (long, random-looking, hex, base64, known key prefixes, digits) is never sent.

export const maxKeyterms = 40
const minLength = 3
const maxLength = 32
// Deepgram allows 500 tokens across all keyterms; stay far below it.
const maxTotalLength = 600

// Common English words (SCOWL sizes 10–60, with American and British spellings, inflections
// included). Loaded once, lazily.
let common: Promise<Set<string>> | undefined
export function commonWords() {
  return (common ??= (async () => {
    const folder = dirname(createRequire(import.meta.url).resolve('wordlist-english/package.json'))
    const lists = await Promise.all(
      ['english', 'american', 'british'].flatMap((dialect) =>
        [10, 20, 35, 40, 50, 55, 60].map(
          async (size) =>
            JSON.parse(
              await readFile(join(folder, `${dialect}-words-${size}.json`), 'utf8'),
            ) as string[],
        ),
      ),
    )
    return new Set(lists.flat().map((word) => word.toLowerCase()))
  })())
}

// Prefixes of API keys and tokens (OpenAI/Anthropic, GitHub, Slack, AWS, Google, Stripe, JWTs…).
const keyPrefix =
  /^(sk|pk|rk|ghp|gho|ghu|ghs|ghr|github|xox[abprs]?|akia|asia|aiza|eyj|whsec|glpat)/i
// Short acronyms that are just ordinary words in caps.
const plainCaps = new Set(['OK', 'ID', 'AM', 'PM', 'US', 'UK', 'TV', 'FAQ', 'ETA', 'TODO', 'NOTE'])

// A token that could be a secret or random data, rather than a word someone would say.
function looksSecret(token: string) {
  if (token.length > 20 && !/^[A-Z]?[a-z]+(?:[A-Z][a-z]+)+$/.test(token)) return true
  if (keyPrefix.test(token) && token.length >= 12) return true
  if (/^[a-f0-9]{8,}$/i.test(token)) return true
  // Words split into readable parts ("use|State", "XML|Http|Request"); random strings break
  // into many one-letter or vowel-less fragments.
  const parts = token.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []
  const fragments = parts.filter((part) => part.length === 1 || !/[aeiouy]/i.test(part))
  return parts.length > 4 || fragments.length > 1
}

type Candidate = { term: string; kind: 'identifier' | 'acronym' | 'name' | 'word' }

// The words worth boosting in one reply, in order. `sentenceStart` capitals don't count as names.
function candidates(markdown: string, words: Set<string>): Candidate[] {
  const prose = markdown
    // Code blocks can hold configs, .env files, or output: never mine them.
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n')
    .replace(/\b(?:https?|wss?|ftp):\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
  const found: Candidate[] = []
  for (const match of prose.matchAll(/[A-Za-z0-9][\w./'’-]*/g)) {
    const raw = match[0].replace(/[._/'’-]+$/, '')
    const before = prose.slice(0, match.index).trimEnd()
    // A capital right after anything but a word, comma, or closing bracket (a full stop, a
    // bullet, a table cell, an emoji…) starts a phrase, so it doesn't make the word a name.
    const sentenceStart = !before || !/[\p{L}\p{N},;)\]'"’”`]$/u.test(before)
    // Paths and file names: keep the name ("src/components/Workspace.tsx" → "Workspace").
    const name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
    const base = /^[\w-]+\.[a-z]{1,5}$/i.test(name) ? name.slice(0, name.lastIndexOf('.')) : name
    // Judge the whole token before splitting it: a key like "xoxb-1234-abcdef" must not leak
    // through its harmless-looking pieces.
    if (
      base.length > maxLength ||
      (base.match(/\d/g) ?? []).length > 2 ||
      (keyPrefix.test(base) && base.length >= 8)
    )
      continue
    // snake_case and kebab-case are spoken as separate words.
    const pieces = /[_-]/.test(base) ? base.split(/[_-]+/) : [base]
    if (pieces.some((piece) => piece.length >= minLength && looksSecret(piece))) continue
    for (const piece of pieces) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(piece)) continue
      if (piece.length < minLength || piece.length > maxLength) continue
      if ((piece.match(/\d/g) ?? []).length > 2 || looksSecret(piece)) continue
      const lower = piece.toLowerCase()
      const known = words.has(lower)
      if (/[a-z][A-Z]|[A-Z]{2}[a-z]/.test(piece)) {
        if (!known) found.push({ term: piece, kind: 'identifier' })
      } else if (/^[A-Z]{2,6}\d?$/.test(piece)) {
        if (!plainCaps.has(piece)) found.push({ term: piece, kind: 'acronym' })
      } else if (/^[A-Z][a-z]+\d?$/.test(piece)) {
        if (!sentenceStart || !known) found.push({ term: piece, kind: known ? 'name' : 'word' })
      } else if (/^[a-z]+\d?$/.test(piece) && !known && piece.length >= 4) {
        found.push({ term: piece, kind: 'word' })
      }
    }
  }
  return found
}

// Up to 40 keyterms from replies (oldest first), most frequent and most recent first.
export function extractKeyterms(replies: string[], words: Set<string>): string[] {
  const scores = new Map<string, { term: string; score: number; last: number }>()
  replies.forEach((reply, replyIndex) => {
    for (const { term, kind } of candidates(reply, words)) {
      const key = term.toLowerCase()
      const entry = scores.get(key) ?? { term, score: 0, last: 0 }
      // A capitalised common word ("Codex") counts once it's clearly used as a name: three
      // times mid-sentence, so one-off button labels and headings ("Check", "Publish") don't.
      entry.score += kind === 'name' ? 1 / 3 : 1
      entry.last = replyIndex
      scores.set(key, entry)
    }
  })
  const ranked = [...scores.values()]
    .filter((entry) => entry.score >= 0.99)
    .sort((a, b) => b.score - a.score || b.last - a.last)
  const terms: string[] = []
  let total = 0
  for (const { term } of ranked) {
    if (terms.length >= maxKeyterms || total + term.length > maxTotalLength) break
    terms.push(term)
    total += term.length
  }
  return terms
}

// Deepgram supports keyterms on Nova-3 and Flux only.
export const supportsKeyterms = (model: string) => /^(nova-3|flux)/.test(model)
