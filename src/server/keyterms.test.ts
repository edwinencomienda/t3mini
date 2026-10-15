import { beforeAll, expect, it } from 'vitest'
import { commonWords, extractKeyterms, maxKeyterms, supportsKeyterms } from './keyterms'

let words: Set<string>
beforeAll(async () => {
  words = await commonWords()
})

it('picks names, identifiers, acronyms, and jargon, not ordinary words', () => {
  const terms = extractKeyterms(
    [
      'I updated the **sidebar** so the Codex card shows and the Codex logo too. Restart the server afterwards.',
      [
        'Done. The `editableMessage` helper in `src/types.ts` now checks the Codex turn, and',
        'the WebSocket relay sends audio to Deepgram. Run git rebase, then check localhost.',
        'The JSON endpoint stays the same; useState was not needed.',
      ].join('\n'),
    ],
    words,
  )
  for (const term of ['editableMessage', 'Codex', 'WebSocket', 'Deepgram', 'rebase', 'localhost'])
    expect(terms).toContain(term)
  expect(terms).toContain('JSON')
  expect(terms).toContain('useState')
  for (const ordinary of ['updated', 'sidebar', 'server', 'Restart', 'Done', 'endpoint', 'types'])
    expect(terms).not.toContain(ordinary)
})

it('never sends anything that looks like a key, token, or random data', () => {
  // Fake secrets in every shape; none of them may come out, in any piece.
  const secrets = [
    'sk-ant-' + 'api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'ghp' + '_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'AIza' + 'SyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abc',
    'xox' + 'b-1234567890-abcdefghijklmnop',
    '9f86d081884c7d659a2feaa0c55ad015',
    'QmFzZTY0U2VjcmV0VmFsdWVIZXJl',
    'dG9rZW4tdmFsdWU',
    'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  ]
  const reply = [
    `Your key is ${secrets[0]} and the token is \`${secrets[1]}\`.`,
    `AWS: ${secrets[2]}, Google: ${secrets[3]}, JWT ${secrets[4]}.`,
    `Slack ${secrets[5]}; hash ${secrets[6]}; base64 ${secrets[7]} ${secrets[8]} ${secrets[9]}`,
    'Open https://user:Pa55w0rd@api.example.com/v1?token=Zx9Qw8 or mail admin@example.com.',
    '```env',
    'DEEPGRAM_API_KEY=' + 'Kq8sX2vN7mP4rT9wY3zB6cF1hJ5',
    'SupabaseServiceRole=SuperSecretValue',
    '```',
    'Then restart Vite.',
  ].join('\n')
  const terms = extractKeyterms([reply], words)
  const sent = terms.join(' ').toLowerCase()
  for (const secret of secrets)
    for (const piece of secret.split(/[^A-Za-z0-9]+/).filter((part) => part.length >= 6))
      expect(sent).not.toContain(piece.toLowerCase())
  for (const leaked of [
    'pa55w0rd',
    'zx9qw8',
    'kq8sx2vn',
    'supersecretvalue',
    'supabaseservicerole',
    'admin',
  ])
    expect(sent).not.toContain(leaked)
  expect(terms).toContain('Vite')
})

it('caps the list and keeps every term short', () => {
  const many = Array.from(
    { length: 120 },
    (_, index) =>
      `Zorbaxian${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`,
  )
  const terms = extractKeyterms([many.join(' ')], words)
  expect(terms.length).toBeLessThanOrEqual(maxKeyterms)
  expect(terms.join('').length).toBeLessThanOrEqual(600)
  expect(terms.every((term) => term.length <= 32)).toBe(true)
})

it('only uses keyterms with models that support them', () => {
  expect(supportsKeyterms('nova-3')).toBe(true)
  expect(supportsKeyterms('nova-3-medical')).toBe(true)
  expect(supportsKeyterms('flux-general-en')).toBe(true)
  expect(supportsKeyterms('nova-2')).toBe(false)
})

it('adds keyterms to the Deepgram query only for models that support them', async () => {
  const { deepgramParams } = await import('./dictation')
  const before = process.env.DEEPGRAM_MODEL
  try {
    delete process.env.DEEPGRAM_MODEL
    expect(deepgramParams(['Deepgram', 'useState']).getAll('keyterm')).toEqual([
      'Deepgram',
      'useState',
    ])
    process.env.DEEPGRAM_MODEL = 'nova-2'
    expect(deepgramParams(['Deepgram']).getAll('keyterm')).toEqual([])
  } finally {
    if (before === undefined) delete process.env.DEEPGRAM_MODEL
    else process.env.DEEPGRAM_MODEL = before
  }
})
