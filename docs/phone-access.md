# Devices / phone access (developer guide)

In the UI this is **Settings → Devices**: any browser can pair (another computer, a tablet, a phone). The code still calls it phone access (`remote.ts`, `PhoneAccess.tsx`, `/api/remote`, `T3_MINI_PHONE_PORT`), and this guide says "phone" for any paired device.

How t3 mini lets a phone use the app, over the local network or over Tailscale, why it's built this way, and what to watch for when changing it. User-facing docs are in the README's **Devices** section.

## Summary

- The app server stays **loopback-only** (`127.0.0.1:4011` for the installed `t3mini`, `4016` for the dev server). Phone access never changes that. The dev server uses its own gateway ports (4316, Tailscale 8444), so both copies can have phone access on at once.
- When the user switches phone access on, a separate **gateway** (`src/server/remote.ts`) starts on port `4311`. It authenticates every request and forwards allowed ones to the app over loopback. Two modes:
  - **Local network** (`lan`, plain HTTP): the gateway listens on all interfaces.
  - **Tailscale** (`tailscale`, HTTPS): the gateway listens on **loopback only**, and `tailscale serve` (`src/server/tailscale.ts`) publishes it at `https://<MagicDNS name>:8443` to the tailnet. See [Tailscale (HTTPS)](#tailscale-https).
- Phones pair by scanning a **QR code** with a **one-time code** (5 minutes), which the gateway trades for a **30-day session cookie**.
- The gateway marks forwarded requests with `x-t3-remote: 1`. The API uses that to refuse **Mac-only** actions and tells the page it's remote so the UI hides them.
- Phone access starts **off** after every server restart. The one exception: **Tailscale** access the user left on comes back by itself (**Reconnect after restart**, on by default), so paired phones reconnect without re-scanning. Local-network access never comes back on its own. Paired devices persist (hashed).

## The iOS app

`ios/` is a native app ([ios/README.md](../ios/README.md)) that is just another paired device. It pairs by posting the code to `POST /pair` itself (form-encoded, no `Origin`, not following the 303), keeps the session cookie from `Set-Cookie` in the Keychain, and sends it as a `Cookie` header to that gateway address only. It then uses the same API as the web page: `/api/events?patch=1&thread=…`, `/api/threads/:id/send|stop|approve|read`, `POST /api/threads`. Its user agent `t3mini-ios/<version> (iPhone|iPad)` names it **iPhone · t3 mini app** (`deviceName()`). Nothing else on the server is specific to it; keep it that way, so the app never becomes a second way in. Keep `POST /pair` working without an `Origin` header (the app and `machines.ts` both rely on it; `allowed()` only refuses a wrong one).

## Request flow

```text
Phone (Safari)                                  Mac
──────────────                                  ───────────────────────────────────────────────
http://10.10.16.103:4311/…  ──►  Gateway (remote.ts, 0.0.0.0:4311, only while on)
                                   1. Host must be <this Mac's LAN IPv4>:<port>
                                   2. Source address must be private (RFC 1918 / link-local)
                                   3. Origin, if present, must be the gateway's own origin
                                   4. GET /pair?code=…  → "Connect this device" page (code not used)
                                      POST /pair (form)  → trade code for cookie, 303 to /
                                      anything else → valid session cookie required (else 401)
                                   5. Rewrite headers and forward to 127.0.0.1:<app port>
                                        Host/Origin → 127.0.0.1:<app port>
                                        strip client x-t3-* headers, Referer, session cookie
                                        add x-t3-remote: 1
                                 ──►  App (t3mini 127.0.0.1:4011, or dev 127.0.0.1:4016)
                                        checkRequest(): loopback + same-origin  ✓ (rewritten)
                                        handleApi(): remote = x-t3-remote === '1'
```

WebSocket upgrades (Vite's dev live reload) take the same checks, then are piped raw to the app with the same header rewrite. SSE (`/api/events`) and normal responses stream through `http.request` piping.

## Files

| File                                                  | What it does                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/remote.ts`                                | `RemoteAccess`: device store, pairing codes, session checks, the gateway server (HTTP + WebSocket upgrade), header rewriting, revocation. `getRemoteAccess()` keeps one instance per process on `globalThis`. |
| `src/server/api.ts`                                   | `/api/remote*` routes (Mac-only), the `macOnly()` guard on Mac-only actions, and `remote` / `phoneAccess` in `/api/bootstrap`. QR images are generated here with `qrcode` (`toDataURL`).                      |
| `src/components/PhoneAccess.tsx`                      | Settings → Devices: the switch, warning, QR code with countdown, multiple-address picker, paired devices with revoke.                                                                                         |
| `src/components/Notifications.tsx`                    | `SettingsDialog` renders `PhoneAccess` only when not remote.                                                                                                                                                  |
| `src/components/Workspace.tsx`                        | Footer phone icon while on; hides **Open in VS Code** and **Browse** when `bootstrap.remote`; toast/unread logic that treats a visible page as watched on touch screens.                                      |
| `src/attachments.ts`                                  | `randomId()` and `copyText()`, which work outside secure contexts (see pitfalls); `prepareImage()` converts/downsizes photos on the device.                                                                   |
| `src/server/remote.test.ts`, `src/server/api.test.ts` | Gateway and remote-gating tests.                                                                                                                                                                              |
| `.data/devices.json`                                  | Paired devices (hashed tokens), mode `0600`. Gitignored with the rest of `.data`.                                                                                                                             |
| `.data/phone-access.json`                             | `{ autoResume, wasOn }`: the Reconnect after restart setting, and whether Tailscale access was on when last switched. Mode `0600`.                                                                            |
| `vite.config.ts`, `server.mjs`                        | Once listening, the server calls its own `POST /api/remote/resume` (server code only loads on the first request).                                                                                             |

## API (Mac only; refused with 403 when `x-t3-remote: 1`)

| Method & path                | Body                                                | Returns                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/remote`            |                                                     | `{ enabled, mode, port, addresses, url?, devices, autoResume, resuming, resumeProblem?, tailscale: { available, running, dnsName?, problem? } }`                                             |
| `POST /api/remote`           | `{ enabled: boolean, mode?: 'lan' \| 'tailscale' }` | status; starts/stops the gateway (or switches mode). Uses the app's own port (from the request URL) as the forwarding target. Tailscale problems come back as a 500 with a readable message. |
| `POST /api/remote/settings`  | `{ autoResume: boolean }`                           | status; saves Reconnect after restart. Turning it off stops a reconnect in progress.                                                                                                         |
| `POST /api/remote/resume`    | `{}`                                                | `{ ok }`; sent by the server itself at startup. Turns Tailscale access back on if it was on and the setting is on, retrying in the background.                                               |
| `POST /api/remote/pair`      | `{}`                                                | `{ expiresAt, links: [{ url, qr }] }`, one link per LAN address; `qr` is a PNG data URL. 409 if phone access is off.                                                                         |
| `DELETE /api/remote/devices` | `{ id? }`                                           | status; revokes one device, or all without `id`, and closes their open connections.                                                                                                          |

`/api/bootstrap` also returns `remote` (this page is on a paired phone) and `phoneAccess` (gateway on).

Mac-only actions refused for remote requests: managing phone access, `POST /api/folders/pick` (opens a Finder dialog on the Mac), `POST /api/threads/:id/open-editor` (opens VS Code on the Mac). Everything else (threads, sending, steering, approvals, stop, diff, uploads, settings) works remotely, including agent CLI updates (`/api/provider-updates`, which only runs the CLI's own fixed `update` command) and restarting onto a newer installed t3mini (`/api/app-update`): a paired device can already run agents, so these give it nothing more.

## Settings and constants

| What                     | Where                                                           | Value                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway port             | `T3_MINI_PHONE_PORT` env, `RemoteAccess.port`                   | `4311`                                                                                                                                                    |
| Session length           | `sessionDays` in `remote.ts` (cookie `Max-Age` and `expiresAt`) | 30 days                                                                                                                                                   |
| Pairing code lifetime    | `pairingMs` in `remote.ts`                                      | 5 minutes, single use; the QR code and **Copy link** carry the same link (the link is the secret: anyone who has it can pair until it expires or is used) |
| Cookie (local network)   | `lanCookie` in `remote.ts`                                      | `t3m_session`, `HttpOnly; SameSite=Lax; Path=/` (no `Secure`: the gateway is HTTP)                                                                        |
| Cookie (Tailscale)       | `httpsCookie` in `remote.ts`                                    | `__Host-t3m_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`                                                                                            |
| Tailscale HTTPS port     | `T3_MINI_TAILSCALE_PORT` env, `tailscalePort()`                 | `8443`                                                                                                                                                    |
| Tailscale CLI            | `TAILSCALE_BIN` env, then the app's, then `tailscale` on PATH   | `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (the PATH one is a wrapper script)                                                                 |
| Trusted marker header    | `remoteHeader` in `remote.ts`                                   | `x-t3-remote`                                                                                                                                             |
| Allowed source addresses | `isPrivateAddress()`                                            | `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `127/8` (IPv4, incl. `::ffff:` mapped)                                                                   |
| Offered addresses        | `lanAddresses()`                                                | non-internal IPv4 interfaces in those ranges (e.g. Wi-Fi `en0`, Ethernet `en7`)                                                                           |
| "Last seen" persistence  | `authenticate()`                                                | at most once a minute                                                                                                                                     |

## Security model (keep these invariants)

Anyone who reaches the app can make agents run commands on the Mac (threads default to Full access). So:

1. **The app never listens beyond loopback.** Only the gateway does, and only while switched on. Don't bind Vite or `server.mjs` to `0.0.0.0`; Vite dev also serves source and has its own attack surface.
2. **Off on restart, except Tailscale by choice.** `RemoteAccess` starts disabled. Only Tailscale mode is remembered (`wasOn`, saved by `set()` when the user flips the switch) and resumed by `resume()` when `autoResume` is on (the default, as the user asked). Local-network mode is never resumed: it's plain HTTP on all interfaces, and after a restart the Mac may be on another network. A crash or restart doesn't clear `wasOn`; only switching off does. Resuming goes through the same `enable()`, so every Tailscale check still applies, and pairing is still required. On and off (`set()`, resume attempts) run one at a time, and a manual switch cancels a pending resume.
3. **Only the Mac mints pairing codes.** `/api/remote*` is refused for remote requests.
4. **`x-t3-remote` is only trustworthy because the gateway strips every client `x-t3-*` header** before adding its own. If you add more trusted headers, use the `x-t3-` prefix so they're stripped too.
5. **Host, source address, and Origin checks** in `allowed()` block DNS rebinding and other sites driving the gateway. `checkRequest()` in `api.ts` still enforces loopback + same-origin for the app itself.
6. **Store hashes only.** Codes and session tokens are SHA-256 hashed in memory and on disk; the raw token exists only in the phone's cookie.
7. **Revocation is immediate.** `revoke()` destroys tracked sockets (SSE, WebSockets) for that device.
8. **Secrets only over HTTPS.** The gateway adds `x-t3-transport` (`https` in Tailscale mode, `http` on the local network; a client's own value is stripped like every `x-t3-*` header), and `POST /api/threads/:id/secret` (`request_secret`) refuses remote requests that aren't `https`, so an API key never crosses the Wi-Fi unencrypted. AssemblyAI dictation tokens (`POST /api/dictation/token`: short-lived, Dictation-only, minted with the Mac's key so the phone can send its recording straight to AssemblyAI) follow the same rule.
9. **Plain HTTP is a known risk** in local-network mode. Anyone who can watch traffic on the network can steal the cookie. The UI and README say "trusted network only" and point to Tailscale (HTTPS), which removes this.
10. **Tailscale mode is tailnet-only and loopback-only.** Only `tailscale serve`, **never Funnel** (public internet). The gateway binds `127.0.0.1` in that mode, accepts only `Host` = the tailnet name with an `https://` origin from loopback (where `serve` connects from), and uses a separate `Secure` cookie. Being on the tailnet is not authentication: pairing still applies, and Tailscale's identity headers (`tailscale-*`) are stripped, never trusted.
11. **Opening a pairing link never pairs.** `GET /pair` only checks the code (without using it) and shows a **Connect this device** button; the form `POST /pair` uses it. Link previews (iMessage fetches a sent link from the sender's device, which can be on the tailnet) and browsers preloading a pasted URL would otherwise burn the one-time code before the person opens it, the "This code has expired" bug from **Copy link**. Keep pairing behind a POST, and keep that POST same-origin (`allowed()`), form-encoded, and small. The gateway's pages are inert: a CSP with `default-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`, `no-store`, and `Referrer-Policy: same-origin` (not `no-referrer`: with it, browsers post the form with `Origin: null`, which `allowed()` refuses, so Connect showed "Forbidden"); the code is checked against its base64url format before it's put in the page.
12. **The serve entry never outlives phone access.** It's removed on disable, on process exit (synchronously), and at startup if a stale one points at our gateway port. Only an entry that proxies to our gateway is ever removed; anything else the user serves is left alone.

## Pitfalls we hit (read before changing client code)

- **Phones load the app from an insecure context.** `http://10.10.16.103:4311` is not `localhost`, so browsers disable secure-context APIs there. This silently broke image attachments once:
  - `crypto.randomUUID()` doesn't exist. Use `randomId()` from `src/attachments.ts`. (`crypto.getRandomValues()` is fine.)
  - `navigator.clipboard` is missing. Use `copyText()`.
  - The Notification API needs HTTPS, and phones need a service worker: on iPhone, only t3 mini added to the home screen gets push (see [Push notifications](#push-notifications)). In a Safari tab, phones get in-app toasts and sound only.
  - Over Tailscale (HTTPS) the page **is** a secure context, so the microphone (dictation) and Clipboard API work there; keep the fallbacks for local-network mode.
  - Before using any new browser API in the client, check MDN for "Secure context: This feature is available only in secure contexts".
- **Never let a client async handler fail silently.** Attach paths go through `attachFiles()`, which shows errors above the composer. Follow the same pattern for new phone-reachable actions.
- **iOS Safari won't open a `display:none` file input from a script `click()`.** The **+** attach button is a `<label>` with the real `<input type="file">` stretched over it (`.attach-button`). The label has `overflow: hidden` so the input can't spill over and steal taps from Send.
- **iOS Safari reports `document.hasFocus() === false` while the page is on screen.** Toast/unread logic treats a visible page as watched on `(pointer: coarse)` devices and never toasts the thread on screen.
- **Touch targets.** Composer buttons are 40px with a 10px gap under `@media (pointer: coarse)`; the 28px desktop size was too small to hit reliably.
- **iPhone photos** can be HEIC or very large. `prepareImage()` converts anything the browser can decode and scales to ≤2048px / ~4 MB before upload (Claude rejects images over ~5 MB).

## Testing

Automated (`bun run test`):

- `src/server/remote.test.ts` runs the real gateway against a stand-in upstream on loopback (`addresses: () => ['127.0.0.1']`): off by default, unpaired 401, wrong Host 403, foreign Origin 403, single-use and expiring codes, header rewriting (`x-t3-remote`, Host, Origin, cookie stripping), hashed storage, expired devices dropped on load, revocation, port closed when off, and the private address ranges.
- `src/server/api.test.ts` checks that remote requests can't manage phone access, browse folders, or open VS Code, and that bootstrap reports `remote: true`.
- Tailscale mode in `remote.test.ts` uses a stand-in `TailscaleControl`: serve on enable, HTTPS pairing links, `__Host-`/`Secure` cookie, LAN host / `http://` origin / plain-HTTP cookie refused, `tailscale-*` headers stripped, failures leave nothing open, stop on disable and on switching back to the local network.
- `src/server/tailscale.test.ts` runs the real wrapper against a fake `tailscale` script (`TAILSCALE_BIN`): status parsing (running, stopped with a non-zero exit, no MagicDNS, missing CLI), exact `serve` arguments (no Funnel), the "enable HTTPS" link, and removing only our own serve entry.

Manual end-to-end on the Mac (no phone needed). Run with the dev server up and no agents running; it pairs a fake device over the real LAN address, then cleans up:

```sh
L=http://127.0.0.1:4016; H='Content-Type: application/json'
curl -s -X POST -H "$H" -d '{"enabled":true}' $L/api/remote
URL=$(curl -s -X POST -H "$H" -d '{}' $L/api/remote/pair | node -pe 'JSON.parse(require("fs").readFileSync(0)).links[0].url')
HOST=$(echo "$URL" | sed -E 's#http://([^/]+)/.*#\1#')
curl -s -o /dev/null -w 'unpaired: %{http_code}\n' http://$HOST/                  # 401
CODE=${URL##*code=}
curl -s -o /dev/null -w 'open link: %{http_code}\n' "$URL"                         # 200 (code not used)
curl -s -o /dev/null -c /tmp/jar -w 'pair: %{http_code}\n' -H "Origin: http://$HOST" \
  --data-urlencode "code=$CODE" http://$HOST/pair                                  # 303
curl -s -o /dev/null -w 'reuse code: %{http_code}\n' "$URL"                        # 401
curl -s -b /tmp/jar http://$HOST/api/bootstrap | head -c 200; echo                 # "remote":true
curl -s -N --max-time 2 -b /tmp/jar http://$HOST/api/events | head -c 80; echo    # data: {...}
curl -s -X DELETE -H "$H" -d '{}' $L/api/remote/devices >/dev/null                 # revoke all
curl -s -X POST -H "$H" -d '{"enabled":false}' $L/api/remote; rm -f /tmp/jar      # switch off
```

On a real phone: Settings → Devices → on → Connect a device → scan. For a computer, use **Copy link** and open it in that computer's browser. Check sending, steering, an image upload, the Changes panel, and that Browse and Open in VS Code are hidden.

## Troubleshooting

| Symptom                                                  | Likely cause                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone can't load the page at all                         | macOS firewall blocked `node` (allow it), phone on a different network or a guest Wi-Fi with client isolation, or phone access is off (local-network access turns off on restart; Tailscale access reconnects unless Reconnect after restart is off). |
| "Not connected" page                                     | No or expired session, or the device was revoked. Scan a new QR code.                                                                                                                                                                                 |
| "This code has expired"                                  | Codes last 5 minutes and work once. Show a new one.                                                                                                                                                                                                   |
| Forbidden (403)                                          | The URL uses an address that isn't one of this Mac's current LAN addresses (e.g. the Mac changed networks), or a non-private source address. Use the address shown under the QR code.                                                                 |
| Something works on the Mac but silently not on the phone | A secure-context-only API (see Pitfalls).                                                                                                                                                                                                             |
| "Could not start phone access on port 4311"              | Another process uses the port. Set `T3_MINI_PHONE_PORT`.                                                                                                                                                                                              |
| Server code changes not taking effect                    | The dev server keeps one service and one `RemoteAccess` on `globalThis` across hot reloads. Restart `bun run dev` (local-network phone access turns off; Tailscale access reconnects by itself).                                                      |

## Push notifications

Web Push, so a phone is notified when a thread finishes, fails, or needs you, even with t3 mini closed. No Apple account or app: on iPhone it's t3 mini added to the home screen (iOS 16.4+), over Tailscale HTTPS.

```text
Thread status changes ─► watchThreads (push.ts, started in getService)
                          same events as the web app (threadEvents), not while you're watching it,
                          not helpers or stopped turns, checked at most twice a second
                        ─► PushNotifications.send: per subscription, encrypted for that browser
                          (web-push, VAPID-signed with this server's key), to its push service only
                        ─► Apple / Google / Mozilla / Microsoft ─► the phone ─► public/sw.js shows it;
                          a tap opens /threads/<id>
```

- **Files:** `src/server/push.ts` (keys, subscriptions, sending, the watcher), `/api/push*` in `api.ts`, `src/push.ts` (subscribe in the browser), `components/PushSetting.tsx` (Settings → Notifications), `public/sw.js`, `public/manifest.webmanifest` and icons, the home-screen tags in `routes/__root.tsx`.
- **API:** `GET /api/push?endpoint=` (`{ publicKey, subscribed }`), `POST /api/push` (`PushSubscription.toJSON()`), `DELETE /api/push` (`{ endpoint }`), `POST /api/push/test` (`{ endpoint }`, that browser only).
- **Security:**
  - The server's VAPID key pair is made once and kept in `.data/push.json` (mode 0600) with the subscriptions; the private key never leaves it.
  - Subscriptions are only accepted for the browsers' push services (`allowedPushHost`: https, port 443, Apple/Google/Mozilla/Microsoft hosts), so a subscription can't make the server call anything else (no SSRF).
  - Messages are end-to-end encrypted to the browser (RFC 8291): the push service delivers them but can't read the title.
  - A paired device's subscription carries its device id (the gateway's `x-t3-device`, trusted only on gateway requests). Revoking the device, or its session expiring, stops its pushes and drops the subscription. Gone subscriptions (404/410) are dropped.
  - The service worker caches nothing and only opens paths inside t3 mini.
- **Gateway:** the home-screen app's own files (`publicAppFiles` in `remote.ts`: the manifest, `sw.js`, icons) are forwarded without a session, GET only, those exact paths with no query, with no cookies, and still only on the gateway's address. Browsers fetch them without cookies, and a home-screen app may not be paired yet. They're static and contain nothing private.
- **Pairing a home-screen app:** it may keep its own cookies apart from Safari, and it has no address bar to open a pairing link. The **Not connected** page has a box to paste the link (or code); it posts to `/pair` like the Connect button (`pairingCode()` takes the code out of a pasted link).
- **Testing:** `src/server/push.test.ts` (allowed hosts, 0600 file, sending with a stand-in, dropping revoked and gone subscriptions, the watcher's events); `remote.test.ts` (public files without a session and nothing else, pairing by pasting the link). On a phone: Settings → Notifications → on → Send a test.
- **The native iOS app (`ios/`)** gets them through APNs instead (`src/server/apns.ts`):
  - **The key:** an APNs auth key (`.p8`) from the user's Apple developer account (Keys → Apple Push Notifications service, Sandbox & Production, team scoped), with its key id and the team id, in `apns.json` (mode 0600) in the data folder. Set it on the Mac only (`POST /api/push/apns`, refused for paired devices); `GET` says only whether it's set and the key id. Never in the repo, the app, logs, or API answers.
  - **Sending:** an ES256 provider token signed with the key via Node's crypto (reused for 40 minutes), HTTP/2 to `api.sandbox.push.apple.com` (development builds) or `api.push.apple.com`, nowhere else. Tokens Apple reports gone (410, BadDeviceToken, Unregistered…) are dropped.
  - **Registering:** the app sends its device token, environment, and bundle id (`POST /api/push/app`; `GET`, `DELETE`, and `POST /api/push/app/test` too). It belongs to the paired device, like a Web Push subscription: revoking the device stops it.
  - **Privacy:** APNs messages aren't end-to-end encrypted, so Apple can read what's in the clear: only `brief` ("A thread finished.") and the thread's path. The title and project go **sealed**: when notifications are turned on, the app makes a 256-bit key (`ios/Shared/PushKey.swift`, kept in a Keychain group shared only with its notification extension) and registers it with its token; the server encrypts `{title, body}` with AES-256-GCM (`sealForApp`, Node's crypto) and sets `mutable-content`; the extension (`ios/T3MiniNotify`) opens it with CryptoKit before the notification is shown. No key, or anything off: the brief line stays. The extension never sees the computer's session.
- **Subject:** VAPID needs a contact (`mailto:`/`https:`); set `T3_MINI_PUSH_SUBJECT` to use your own instead of the placeholder.

## Previews of dev servers (proof of concept)

A paired device can open a dev server that runs on this Mac (`localhost:3000`): **● running** → **Open on this device**.

```text
Phone ──► <tailnet name>:13000 (tailscale serve, HTTPS)  or  <LAN address>:13000 (HTTP)
            ──► preview listener (previews.ts): right address? valid preview cookie (or one-time pass)?
              ──► localhost:3000, as if from localhost
```

- **Files:** `src/server/previews.ts` (`Previews`: one listener per shared dev server), `RemoteAccess.previews` / `previewHost()` in `remote.ts`, `POST /api/previews` in `api.ts`, `servePort` / `stopServingPort` in `tailscale.ts`, `openPreview()` in `components/Processes.tsx`; tests in `previews.test.ts`.
- **Address:** its own port, the dev server's + 10000, at the root: apps assume they live at `/` (a sub-path like `/preview/3000/` breaks React, Vue, Angular, and Svelte; see code-server's docs). Over Tailscale the listener is loopback-only and `tailscale serve --https=<port+10000>` publishes it; on the local network it listens on every interface, like the gateway. A taken port fails with a readable 409.
- **Who gets in:** `POST /api/previews {port}` is refused unless it comes through the gateway from a paired device (the gateway adds `x-t3-device` with the device id; it strips every client `x-t3-*` header first), and only for a port a running process t3 mini started printed (`ProcessInfo.urls`: every local address it printed, up to 5, since a monorepo's `dev` often starts a website and an API side by side), never another local service. It returns one link per address with a one-time pass (2 minutes, stored hashed). Opening `/__t3-preview?pass=…` trades it for an HttpOnly cookie for that address (`__Host-t3p_<port>`, Secure, over Tailscale; `t3p_<port>` on the local network), good for 12 hours and only while the device stays paired. The same Host/source/Origin checks as the gateway block DNS rebinding and other sites.
- **Forwarding:** to `localhost:<port>` (both IPv4 and IPv6) with `Host` and `Origin` set to `localhost:<port>` (so Vite's host check and auth libraries' origin checks pass), `Referer` rewritten, `x-forwarded-*`, `tailscale-*`, and `x-t3-*` removed, and t3 mini's cookies (`t3m_`/`t3p_`, which the browser sends to every port of the host) removed. Replies: a `Location` back to `localhost:<port>` points at the preview address; `Domain=localhost` is dropped from `Set-Cookie`. WebSockets (live reload) get the same checks and rewriting.
- **Closing:** when the dev server's process stops (the process list is watched), when phone access turns off, and its `tailscale serve` port is turned off at exit like the gateway's.
- **Not handled (outside the proxy):** app code that calls `http://localhost:<port>` directly from the browser, and OAuth providers' registered callback URLs.
- **Links in the chat:** on a paired device, a tap on a `localhost` / `127.0.0.1` / `0.0.0.0` link inside the chat (one click listener on `.chat-content`, so messages don't re-render) opens it the same way (`src/open-preview.ts`), sending its path along: the pass lands on that page (`landingPath()` only allows a path on the same preview: one leading `/`, no `//`, backslashes, spaces, or control characters). Ports nothing t3 mini started is running on say so.
- **Not yet:** a "Stop sharing" button, Copy link on the Mac, and an agent tool to share a preview.

## Tailscale (HTTPS)

Local-network mode is plain HTTP. Tailscale mode adds encryption, a secure context on the phone, and access from anywhere on the tailnet (cellular included), without opening ports. The approach follows t3code (`packages/tailscale/src/tailscale.ts`).

```text
Phone (Tailscale app on)                         Mac
──────────────────────────                       ───────────────────────────────────────────────
https://mac.tail1234.ts.net:8443/…  ──WireGuard──►  tailscaled (`tailscale serve`, tailnet only)
                                                     terminates TLS, proxies to
                                                  ──►  Gateway (remote.ts, 127.0.0.1:4311 only)
                                                         1. Host must be <MagicDNS name>:8443
                                                         2. Source must be loopback (serve)
                                                         3. Origin, if present, https://<that host>
                                                         4. pairing / __Host-t3m_session cookie
                                                         5. same header rewrite as local network
                                                  ──►  App (127.0.0.1:4011 / 4016)
```

- **`src/server/tailscale.ts`**: `tailscaleStatus()` (`tailscale status --json`: `BackendState === 'Running'` and `Self.DNSName`, trailing dot stripped; `status` exits non-zero when stopped but still prints JSON), `serveGateway()` (`tailscale serve --bg --https=<port> http://127.0.0.1:<gateway>`; when the tailnet hasn't enabled HTTPS/Serve, the CLI prints a `login.tailscale.com` link, which is shown to the user), `stopServingGateway()` (reads `serve status --json` and runs `serve --https=<port> off` only if that port proxies to our gateway), and `stopServingGatewayNow()` for process exit. All through `execFile` with timeouts, no shell.
- **`remote.ts`**: `enable(upstreamPort, mode)`. Tailscale mode checks status first, binds the gateway to `127.0.0.1`, then starts `serve`; if `serve` fails the gateway is closed again. Switching modes restarts the gateway (old QR codes and open connections end). `allowed()`, the cookie name and `Secure`, and pairing URLs (`https://<host>/pair?code=…`) depend on the mode. `forwardHeaders()` strips both session cookies and every `tailscale-*` header.
- **UI**: Settings → Devices → **Connection** (Local network | Tailscale (HTTPS)). Tailscale is preselected when it's connected; when it isn't, the reason is shown with **Check again**, and Allow phones stays off. The plain-HTTP warning only shows for the local network.
- **Dictation**: the live-dictation WebSocket accepts paired phones (the gateway already authenticated them), so dictation works on a phone over Tailscale. Over plain HTTP the browser doesn't offer the microphone at all.
- **Existing devices**: a phone paired over the local network has a plain-HTTP cookie, so it scans a new code once for Tailscale (a second device entry).

Setup for users: Tailscale on the Mac and the phone, same tailnet, MagicDNS and HTTPS certificates enabled in the admin console. If the user restricts the tailnet with ACLs, the phone needs access to the Mac on the HTTPS port (8443).

Manual test: phone on cellular with Tailscale on, choose Tailscale (HTTPS), turn on Allow other devices, scan the QR code (or open the copied link), confirm the lock icon, then try sending, steering, an upload, dictation, and revocation. Turn phone access off and check that `tailscale serve status` no longer lists the entry.
