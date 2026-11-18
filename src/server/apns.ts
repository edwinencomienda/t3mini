import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import http2 from 'node:http2'
import { dirname } from 'node:path'
import { z } from 'zod'

// Push notifications for the native iOS app (ios/), through Apple's push service (APNs), next to
// Web Push (push.ts). Uses an APNs auth key (.p8) from the user's Apple developer account:
//
// - The key, its id, and the team id are kept in apns.json (mode 0600) in the data folder. They're
//   set on this Mac only (Settings, or POST /api/push/apns), never sent to a browser or phone, and
//   never logged. Status only says whether it's set and the key id.
// - Each message is signed with a short-lived token (ES256 JWT, the standard APNs provider token,
//   via Node's crypto), reused for 40 minutes as Apple asks.
// - Only Apple's two hosts are ever contacted (sandbox for development builds, production for
//   TestFlight and App Store builds), over HTTP/2.
// - Unlike Web Push, APNs messages aren't end-to-end encrypted: Apple can read them. So in the
//   clear they say only what happened ("A thread finished"); the title and project are sealed with
//   the phone's own key and opened on the phone (push.ts → sealForApp, ios/T3MiniNotify).

export type ApnsConfig = { teamId: string; keyId: string; key: string }
export type ApnsEnvironment = 'sandbox' | 'production'
export const apnsHosts: Record<ApnsEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

export const apnsConfigSchema = z.object({
  teamId: z.string().regex(/^[A-Z0-9]{10}$/, 'The team id is 10 letters and digits.'),
  keyId: z.string().regex(/^[A-Z0-9]{10}$/, 'The key id is 10 letters and digits.'),
  key: z
    .string()
    .max(4096)
    .refine((value) => {
      try {
        const key = createPrivateKey(value)
        return (
          key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
        )
      } catch {
        return false
      }
    }, 'That isn’t an APNs key (.p8).'),
})

export async function readApnsConfig(path: string): Promise<ApnsConfig | null> {
  try {
    return apnsConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}
export async function writeApnsConfig(path: string, input: unknown) {
  const config = apnsConfigSchema.parse(input)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path + '.tmp', JSON.stringify(config), { mode: 0o600 })
  await rename(path + '.tmp', path)
  return config
}

// The provider token: {alg: ES256, kid} . {iss: team, iat}, signed with the key.
export function providerToken(config: ApnsConfig, now = Date.now(), key?: KeyObject) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${encode({ alg: 'ES256', kid: config.keyId })}.${encode({ iss: config.teamId, iat: Math.floor(now / 1000) })}`
  const signature = sign('sha256', Buffer.from(body), {
    key: key ?? createPrivateKey(config.key),
    dsaEncoding: 'ieee-p1363',
  })
  return `${body}.${signature.toString('base64url')}`
}

export type ApnsMessage = {
  token: string
  environment: ApnsEnvironment
  // The app's bundle id.
  topic: string
  // Collapses notifications about the same thread into one.
  collapseId?: string
  payload: object
}
// What the app is told: delivered, gone (drop the token), or failed.
export type ApnsResult = 'sent' | 'gone' | 'failed'
export type ApnsSender = (config: ApnsConfig, message: ApnsMessage) => Promise<ApnsResult>

// Reasons Apple gives when a token will never work again.
const goneReasons = new Set([
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
  'ExpiredToken',
])

export function createApnsSender(): ApnsSender {
  const sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>()
  let cached: { keyId: string; token: string; at: number } | undefined
  const tokenFor = (config: ApnsConfig) => {
    const now = Date.now()
    if (!cached || cached.keyId !== config.keyId || now - cached.at > 40 * 60_000)
      cached = { keyId: config.keyId, token: providerToken(config, now), at: now }
    return cached.token
  }
  const session = (environment: ApnsEnvironment) => {
    let open = sessions.get(environment)
    if (!open || open.closed || open.destroyed) {
      open = http2.connect(apnsHosts[environment])
      open.on('error', () => sessions.delete(environment))
      open.on('close', () => sessions.delete(environment))
      // Close it after a minute without messages (Apple drops idle ones anyway). Not unref():
      // under Node an unref'd session can stall its requests.
      open.setTimeout(60_000, () => open?.close())
      sessions.set(environment, open)
    }
    return open
  }
  return (config, message) =>
    new Promise<ApnsResult>((resolve) => {
      let done = false
      const finish = (result: ApnsResult) => {
        if (done) return
        done = true
        resolve(result)
      }
      try {
        const request = session(message.environment).request({
          ':method': 'POST',
          ':path': `/3/device/${message.token}`,
          authorization: `bearer ${tokenFor(config)}`,
          'apns-topic': message.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
          ...(message.collapseId ? { 'apns-collapse-id': message.collapseId.slice(0, 64) } : {}),
        })
        request.setTimeout(10_000, () => {
          request.close()
          finish('failed')
        })
        let status = 0
        let body = ''
        request.on('response', (headers) => (status = Number(headers[':status'])))
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          if (body.length < 2000) body += chunk
        })
        request.on('end', () => {
          if (status === 200) return finish('sent')
          let reason = ''
          try {
            reason = String((JSON.parse(body) as { reason?: string }).reason ?? '')
          } catch {
            // No JSON reason.
          }
          finish(status === 410 || goneReasons.has(reason) ? 'gone' : 'failed')
        })
        request.on('error', () => finish('failed'))
        request.end(JSON.stringify(message.payload))
      } catch {
        finish('failed')
      }
    })
}
