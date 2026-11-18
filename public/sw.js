// t3 mini's service worker: only push notifications (see src/server/push.ts). It caches nothing
// and handles no requests, so the app always loads fresh from the computer.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// Only a path inside t3 mini is ever opened (never another site), whatever a message says.
const safePath = (value) =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.includes('\\')
    ? value
    : '/'
const text = (value, fallback, max) =>
  typeof value === 'string' && value ? value.slice(0, max) : fallback

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  event.waitUntil(
    self.registration.showNotification(text(data.title, 't3 mini', 120), {
      body: text(data.body, '', 240),
      tag: text(data.tag, 't3-mini', 80),
      icon: '/icon-192.png',
      data: { url: safePath(data.url) },
    }),
  )
})

// Tapping a notification opens its thread. The page does the switching itself (src/push.ts →
// listenForPushOpens): an iPhone home-screen app doesn't reliably support navigate() on an open
// window, and opening it from closed can land on its start page instead of the thread. So:
// - a window is open (or in the background): focus it and tell it which thread to open;
// - none is: remember the thread for a minute (in the Cache API: this worker may be stopped
//   in between), open the app, and hand the thread over when the page says it's ready.
const pendingKey = '/__t3-push-pending'
async function rememberPending(url) {
  const cache = await caches.open('t3-push')
  await cache.put(pendingKey, new Response(JSON.stringify({ url, at: Date.now() })))
}
async function takePending() {
  const cache = await caches.open('t3-push')
  const response = await cache.match(pendingKey)
  if (!response) return null
  await cache.delete(pendingKey)
  try {
    const { url, at } = await response.json()
    return Date.now() - at < 60_000 ? safePath(url) : null
  } catch {
    return null
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = safePath(event.notification.data && event.notification.data.url)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (open) {
        await open.focus().catch(() => {})
        open.postMessage({ t3push: 'open', url })
        return
      }
      await rememberPending(url)
      await self.clients.openWindow(url)
    })(),
  )
})

// A page that just loaded asks for a thread a tap was opening.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.t3push !== 'ready' || !event.source) return
  event.waitUntil(
    takePending().then((url) => {
      if (url) event.source.postMessage({ t3push: 'open', url })
    }),
  )
})
