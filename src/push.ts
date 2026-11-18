// Push notifications in this browser (server side: src/server/push.ts). The service worker
// (public/sw.js) shows them, even with t3 mini closed.
//
// On iPhone and iPad they work only in t3 mini added to the home screen (Safari → Share → Add to
// Home Screen), opened from there, over HTTPS (Tailscale). In Safari's own tabs PushManager
// doesn't exist, so the setting explains how to add it instead.

export type PushState =
  // This browser can't do it (no service worker or push, or not a secure context).
  | 'unsupported'
  // iPhone/iPad in a Safari tab: add to the home screen first.
  | 'install'
  // Notifications are blocked for this site.
  | 'denied'
  | 'off'
  | 'on'

const isAppleMobile = () =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true)

export const pushSupported = () =>
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration('/')
  return (await registration?.pushManager.getSubscription()) ?? null
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isAppleMobile() && !isStandalone() ? 'install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const subscription = await currentSubscription()
    if (!subscription || Notification.permission !== 'granted') return 'off'
    const { subscribed } = await api<{ subscribed: boolean }>(
      `push?endpoint=${encodeURIComponent(subscription.endpoint)}`,
    )
    return subscribed ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

// The server's key as the bytes pushManager.subscribe wants.
function keyBytes(base64url: string) {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

// Turns them on. Call it straight from a tap: browsers (iPhone especially) only ask for
// permission in response to one, so the permission prompt comes first, before anything else.
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return pushState()
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  const { publicKey } = await api<{ publicKey: string }>('push')
  let subscription = await registration.pushManager.getSubscription()
  // Made with another key (the server's keys were reset): start over with this one.
  if (subscription) {
    const key = subscription.options.applicationServerKey
    const current = key ? new Uint8Array(key) : null
    const wanted = keyBytes(publicKey)
    if (
      !current ||
      current.length !== wanted.length ||
      current.some((byte, i) => byte !== wanted[i])
    ) {
      await subscription.unsubscribe()
      subscription = null
    }
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  })
  await api('push', 'POST', subscription.toJSON())
  return 'on'
}

export async function disablePush(): Promise<PushState> {
  const subscription = await currentSubscription().catch(() => null)
  if (subscription) {
    await api('push', 'DELETE', { endpoint: subscription.endpoint }).catch(() => {})
    await subscription.unsubscribe().catch(() => false)
  }
  return pushState()
}

export async function testPush() {
  const subscription = await currentSubscription()
  if (!subscription) throw new Error('Turn notifications on first.')
  await api('push/test', 'POST', { endpoint: subscription.endpoint })
}

// Opens the thread a tapped notification is about (see public/sw.js): from a message when the
// app was already open, or by asking the service worker right after the page loads. Only
// /threads/<id> paths are acted on.
export function threadFromPushUrl(url: unknown) {
  if (typeof url !== 'string') return null
  const match = /^\/threads\/([^/?#]+)$/.exec(url)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}
export function listenForPushOpens(open: (threadId: string) => void) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {}
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { t3push?: string; url?: unknown } | null
    if (data?.t3push !== 'open') return
    const id = threadFromPushUrl(data.url)
    if (id) open(id)
  }
  navigator.serviceWorker.addEventListener('message', onMessage)
  void navigator.serviceWorker.ready
    .then((registration) => {
      const worker = navigator.serviceWorker.controller ?? registration.active
      worker?.postMessage({ t3push: 'ready' })
    })
    .catch(() => {})
  return () => navigator.serviceWorker.removeEventListener('message', onMessage)
}
