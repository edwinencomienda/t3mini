import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  apnsConfigSchema,
  providerToken,
  readApnsConfig,
  writeApnsConfig,
  type ApnsMessage,
} from './apns'
import { PushNotifications } from './push'

// A throwaway P-256 key, like an APNs .p8 (never a real one in tests).
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const config = { teamId: 'ABCDE12345', keyId: 'KEY1234567', key }
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-apns-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('signs a provider token Apple can check', () => {
  const token = providerToken(config, Date.UTC(2026, 10, 18))
  const [header, claims, signature] = token.split('.')
  expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
    alg: 'ES256',
    kid: 'KEY1234567',
  })
  expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
    iss: 'ABCDE12345',
    iat: Date.UTC(2026, 10, 18) / 1000,
  })
  const ok = verify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature!, 'base64url'),
  )
  expect(ok).toBe(true)
})
it('keeps the key in a private file and accepts only APNs-style keys', async () => {
  const path = join(directory, 'apns.json')
  expect(await readApnsConfig(path)).toBeNull()
  await writeApnsConfig(path, config)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await readApnsConfig(path)).toEqual(config)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString()
  expect(apnsConfigSchema.safeParse({ ...config, key: rsa }).success).toBe(false)
  expect(apnsConfigSchema.safeParse({ ...config, key: 'not a key' }).success).toBe(false)
  expect(apnsConfigSchema.safeParse({ ...config, keyId: 'short' }).success).toBe(false)
})
it('sends the app only the brief line, and drops gone tokens and revoked devices', async () => {
  const sent: ApnsMessage[] = []
  let result: 'sent' | 'gone' | 'failed' = 'sent'
  const devices = new Set(['phone', 'ipad'])
  const push = new PushNotifications(join(directory, 'push.json'), {
    send: async () => {},
    deviceExists: (id) => devices.has(id),
    apns: {
      config: async () => config,
      send: async (_config, message) => {
        sent.push(message)
        return result
      },
    },
  })
  const token = 'a'.repeat(64)
  await push.registerApp({ token, environment: 'sandbox', topic: 'com.example.t3mini' }, 'phone')
  await push.registerApp(
    { token: 'b'.repeat(64), environment: 'production', topic: 'com.example.t3mini' },
    'ipad',
  )
  await expect(
    push.registerApp({ token: 'zz', environment: 'sandbox', topic: 'com.example.t3mini' }),
  ).rejects.toThrow()
  await expect(
    push.registerApp({ token, environment: 'sandbox', topic: 'not a bundle id' }),
  ).rejects.toThrow()
  const payload = {
    title: 'Secret project plan',
    body: 'Done · secret-app',
    url: '/threads/t1',
    tag: 't1',
    brief: 'A thread finished.',
  }
  await push.send(payload)
  expect(sent).toHaveLength(2)
  expect(sent[0]).toMatchObject({
    token,
    environment: 'sandbox',
    topic: 'com.example.t3mini',
    collapseId: 't1',
  })
  // Apple can read APNs messages: no title or project goes out, only what happened and where.
  expect(JSON.stringify(sent[0]!.payload)).not.toContain('Secret')
  expect(JSON.stringify(sent[0]!.payload)).not.toContain('secret-app')
  expect(sent[0]!.payload).toEqual({
    aps: {
      alert: { title: 't3 mini', body: 'A thread finished.' },
      sound: 'default',
      'thread-id': 't3mini',
    },
    url: '/threads/t1',
  })
  // The iPad was revoked; then Apple says the phone's token is gone.
  devices.delete('ipad')
  result = 'gone'
  sent.length = 0
  await push.send(payload)
  expect(sent.map((item) => item.token)).toEqual([token])
  expect(await push.appRegistered(token)).toBe(false)
  expect(await push.appRegistered('b'.repeat(64))).toBe(false)
})
it('sends nothing to the app until the key is set up', async () => {
  let calls = 0
  const push = new PushNotifications(join(directory, 'push.json'), {
    send: async () => {},
    apns: { config: async () => null, send: async () => (calls++, 'sent') },
  })
  await push.registerApp({
    token: 'c'.repeat(64),
    environment: 'sandbox',
    topic: 'com.example.t3mini',
  })
  expect(await push.apnsConfigured()).toBe(false)
  await push.send({ title: 'x', body: 'x', url: '/', tag: 'x', brief: 'x' })
  expect(calls).toBe(0)
  expect(await push.appRegistered('c'.repeat(64))).toBe(true)
})
it('seals the title and project so only the phone can read them', async () => {
  const { createDecipheriv, randomBytes } = await import('node:crypto')
  const key = randomBytes(32).toString('base64')
  const sent: ApnsMessage[] = []
  const push = new PushNotifications(join(directory, 'push.json'), {
    send: async () => {},
    apns: { config: async () => config, send: async (_c, message) => (sent.push(message), 'sent') },
  })
  await push.registerApp({
    token: 'd'.repeat(64),
    environment: 'sandbox',
    topic: 'com.example.t3mini',
    key,
  })
  await expect(
    push.registerApp({
      token: 'e'.repeat(64),
      environment: 'sandbox',
      topic: 'com.example.t3mini',
      key: 'short',
    }),
  ).rejects.toThrow()
  await push.send({
    title: 'Fix login',
    body: 'Done · myapp',
    url: '/threads/t1',
    tag: 't1',
    brief: 'A thread finished.',
  })
  const payload = sent[0]!.payload as { aps: Record<string, unknown>; sealed: string }
  expect(payload.aps['mutable-content']).toBe(1)
  expect(JSON.stringify(payload)).not.toContain('Fix login')
  expect(JSON.stringify(payload)).not.toContain('myapp')
  // What the phone does (CryptoKit's combined box: nonce · ciphertext · tag).
  const box = Buffer.from(payload.sealed, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), box.subarray(0, 12))
  decipher.setAuthTag(box.subarray(box.length - 16))
  const opened = Buffer.concat([
    decipher.update(box.subarray(12, box.length - 16)),
    decipher.final(),
  ])
  expect(JSON.parse(opened.toString('utf8'))).toEqual({ title: 'Fix login', body: 'Done · myapp' })
})
