// On a paired phone or tablet: opens a dev server that runs on the computer (a localhost address)
// through t3 mini's preview address for it (see server/previews.ts), at the same page. Used by
// the process list's "Open on this device" and by localhost links tapped in the chat.

// localhost, 127.0.0.1, 0.0.0.0, or [::1], with a port.
export function localDevUrl(href: string) {
  try {
    const url = new URL(href)
    if (!/^https?:$/.test(url.protocol) || !url.port) return null
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(url.hostname) ? url : null
  } catch {
    return null
  }
}

// The tab opens first (phones block tabs opened after waiting on a request), then goes to the
// one-time link for the address this device uses.
export async function openPreview(href: string) {
  const url = localDevUrl(href)
  if (!url) throw new Error('That isn’t a local address.')
  const tab = window.open('', '_blank')
  try {
    const response = await fetch('/api/previews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: Number(url.port),
        path: `${url.pathname}${url.search}${url.hash}`,
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Could not open the preview.')
    const links: string[] = data.urls ?? []
    const link = links.find((item) => new URL(item).hostname === location.hostname) ?? links[0]
    if (!link) throw new Error('Could not open the preview.')
    if (tab) tab.location.href = link
    else location.href = link
  } catch (error) {
    tab?.close()
    throw error
  }
}
