# Phone access (developer guide)

How t3 mini lets a phone on the same local network use the app, why it's built this way, and what to watch for when changing it. User-facing docs are in the README's **Phone access** section.

## Summary

- The app server stays **loopback-only** (`127.0.0.1:4310`). Phone access never changes that.
- When the user switches phone access on, a separate **gateway** (`src/server/remote.ts`) starts listening on port `4311` on all interfaces. It authenticates every request and forwards allowed ones to the app over loopback.
- Phones pair by scanning a **QR code** with a **one-time code** (5 minutes), which the gateway trades for a **30-day session cookie**.
- The gateway marks forwarded requests with `x-t3-remote: 1`. The API uses that to refuse **Mac-only** actions and tells the page it's remote so the UI hides them.
- Phone access is **in memory only**: it is off after every server restart, by design. Paired devices persist (hashed) so they reconnect without re-scanning once it's switched back on.

## Request flow

```text
Phone (Safari)                                  Mac
──────────────                                  ───────────────────────────────────────────────
http://10.10.16.103:4311/…  ──►  Gateway (remote.ts, 0.0.0.0:4311, only while on)
                                   1. Host must be <this Mac's LAN IPv4>:<port>
                                   2. Source address must be private (RFC 1918 / link-local)
                                   3. Origin, if present, must be the gateway's own origin
                                   4. /pair?code=…  → trade code for cookie, 302 to /
                                      anything else → valid session cookie required (else 401)
                                   5. Rewrite headers and forward to 127.0.0.1:<app port>
                                        Host/Origin → 127.0.0.1:<app port>
                                        strip client x-t3-* headers, Referer, session cookie
                                        add x-t3-remote: 1
                                 ──►  App (Vite dev or server.mjs, 127.0.0.1:4310)
                                        checkRequest(): loopback + same-origin  ✓ (rewritten)
                                        handleApi(): remote = x-t3-remote === '1'
```

WebSocket upgrades (Vite's dev live reload) take the same checks, then are piped raw to the app with the same header rewrite. SSE (`/api/events`) and normal responses stream through `http.request` piping.

## Files

| File                                                  | What it does                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/remote.ts`                                | `RemoteAccess`: device store, pairing codes, session checks, the gateway server (HTTP + WebSocket upgrade), header rewriting, revocation. `getRemoteAccess()` keeps one instance per process on `globalThis`. |
| `src/server/api.ts`                                   | `/api/remote*` routes (Mac-only), the `macOnly()` guard on Mac-only actions, and `remote` / `phoneAccess` in `/api/bootstrap`. QR images are generated here with `qrcode` (`toDataURL`).                      |
| `src/components/PhoneAccess.tsx`                      | Settings → Phone access: the switch, warning, QR code with countdown, multiple-address picker, paired devices with revoke.                                                                                    |
| `src/components/Notifications.tsx`                    | `SettingsDialog` renders `PhoneAccess` only when not remote.                                                                                                                                                  |
| `src/components/Workspace.tsx`                        | Footer phone icon while on; hides **Open in VS Code** and **Browse** when `bootstrap.remote`; toast/unread logic that treats a visible page as watched on touch screens.                                      |
| `src/attachments.ts`                                  | `randomId()` and `copyText()`, which work outside secure contexts (see pitfalls); `prepareImage()` converts/downsizes photos on the device.                                                                   |
| `src/server/remote.test.ts`, `src/server/api.test.ts` | Gateway and remote-gating tests.                                                                                                                                                                              |
| `.data/devices.json`                                  | Paired devices (hashed tokens), mode `0600`. Gitignored with the rest of `.data`.                                                                                                                             |

## API (Mac only; refused with 403 when `x-t3-remote: 1`)

| Method & path                | Body                   | Returns                                                                                                              |
| ---------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /api/remote`            |                        | `{ enabled, port, addresses, devices }`                                                                              |
| `POST /api/remote`           | `{ enabled: boolean }` | status; starts/stops the gateway. Uses the app's own port (from the request URL) as the forwarding target.           |
| `POST /api/remote/pair`      | `{}`                   | `{ expiresAt, links: [{ url, qr }] }`, one link per LAN address; `qr` is a PNG data URL. 409 if phone access is off. |
| `DELETE /api/remote/devices` | `{ id? }`              | status; revokes one device, or all without `id`, and closes their open connections.                                  |

`/api/bootstrap` also returns `remote` (this page is on a paired phone) and `phoneAccess` (gateway on).

Mac-only actions refused for remote requests: managing phone access, `POST /api/folders/pick` (opens a Finder dialog on the Mac), `POST /api/threads/:id/open-editor` (opens VS Code on the Mac). Everything else (threads, sending, steering, approvals, stop, diff, uploads, settings) works remotely.

## Settings and constants

| What                     | Where                                                           | Value                                                                                   |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Gateway port             | `T3_MINI_PHONE_PORT` env, `RemoteAccess.port`                   | `4311`                                                                                  |
| Session length           | `sessionDays` in `remote.ts` (cookie `Max-Age` and `expiresAt`) | 30 days                                                                                 |
| Pairing code lifetime    | `pairingMs` in `remote.ts`                                      | 5 minutes, single use                                                                   |
| Cookie                   | `cookieName` in `remote.ts`                                     | `t3m_session`, `HttpOnly; SameSite=Lax; Path=/` (no `Secure`: the gateway is HTTP)      |
| Trusted marker header    | `remoteHeader` in `remote.ts`                                   | `x-t3-remote`                                                                           |
| Allowed source addresses | `isPrivateAddress()`                                            | `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `127/8` (IPv4, incl. `::ffff:` mapped) |
| Offered addresses        | `lanAddresses()`                                                | non-internal IPv4 interfaces in those ranges (e.g. Wi-Fi `en0`, Ethernet `en7`)         |
| "Last seen" persistence  | `authenticate()`                                                | at most once a minute                                                                   |

## Security model (keep these invariants)

Anyone who reaches the app can make agents run commands on the Mac (threads default to Full access). So:

1. **The app never listens beyond loopback.** Only the gateway does, and only while switched on. Don't bind Vite or `server.mjs` to `0.0.0.0`; Vite dev also serves source and has its own attack surface.
2. **Off on restart.** `RemoteAccess` starts disabled and the switch isn't persisted. Keep it that way unless the user asks otherwise.
3. **Only the Mac mints pairing codes.** `/api/remote*` is refused for remote requests.
4. **`x-t3-remote` is only trustworthy because the gateway strips every client `x-t3-*` header** before adding its own. If you add more trusted headers, use the `x-t3-` prefix so they're stripped too.
5. **Host, source address, and Origin checks** in `allowed()` block DNS rebinding and other sites driving the gateway. `checkRequest()` in `api.ts` still enforces loopback + same-origin for the app itself.
6. **Store hashes only.** Codes and session tokens are SHA-256 hashed in memory and on disk; the raw token exists only in the phone's cookie.
7. **Revocation is immediate.** `revoke()` destroys tracked sockets (SSE, WebSockets) for that device.
8. **Plain HTTP is a known risk.** Anyone who can watch traffic on the network can steal the cookie. The UI and README say "trusted network only". The planned Tailscale HTTPS mode (see "Future" below) removes this.

## Pitfalls we hit (read before changing client code)

- **Phones load the app from an insecure context.** `http://10.10.16.103:4311` is not `localhost`, so browsers disable secure-context APIs there. This silently broke image attachments once:
  - `crypto.randomUUID()` doesn't exist. Use `randomId()` from `src/attachments.ts`. (`crypto.getRandomValues()` is fine.)
  - `navigator.clipboard` is missing. Use `copyText()`.
  - The Notification API needs HTTPS, so phones get in-app toasts and sound only. The Settings toggle shows it as unsupported or blocked, depending on the browser.
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

Manual end-to-end on the Mac (no phone needed). Run with the dev server up and no agents running; it pairs a fake device over the real LAN address, then cleans up:

```sh
L=http://127.0.0.1:4310; H='Content-Type: application/json'
curl -s -X POST -H "$H" -d '{"enabled":true}' $L/api/remote
URL=$(curl -s -X POST -H "$H" -d '{}' $L/api/remote/pair | node -pe 'JSON.parse(require("fs").readFileSync(0)).links[0].url')
HOST=$(echo "$URL" | sed -E 's#http://([^/]+)/.*#\1#')
curl -s -o /dev/null -w 'unpaired: %{http_code}\n' http://$HOST/                  # 401
curl -s -o /dev/null -c /tmp/jar -w 'pair: %{http_code}\n' "$URL"                 # 302
curl -s -o /dev/null -w 'reuse code: %{http_code}\n' "$URL"                        # 401
curl -s -b /tmp/jar http://$HOST/api/bootstrap | head -c 200; echo                 # "remote":true
curl -s -N --max-time 2 -b /tmp/jar http://$HOST/api/events | head -c 80; echo    # data: {...}
curl -s -X DELETE -H "$H" -d '{}' $L/api/remote/devices >/dev/null                 # revoke all
curl -s -X POST -H "$H" -d '{"enabled":false}' $L/api/remote; rm -f /tmp/jar      # switch off
```

On a real phone: Settings → Phone access → on → Connect a phone → scan. Check sending, steering, an image upload, the Changes panel, and that Browse and Open in VS Code are hidden.

## Troubleshooting

| Symptom                                                  | Likely cause                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone can't load the page at all                         | macOS firewall blocked `node` (allow it), phone on a different network or a guest Wi-Fi with client isolation, or phone access is off (it turns off on restart).                      |
| "Not connected" page                                     | No or expired session, or the device was revoked. Scan a new QR code.                                                                                                                 |
| "This code has expired"                                  | Codes last 5 minutes and work once. Show a new one.                                                                                                                                   |
| Forbidden (403)                                          | The URL uses an address that isn't one of this Mac's current LAN addresses (e.g. the Mac changed networks), or a non-private source address. Use the address shown under the QR code. |
| Something works on the Mac but silently not on the phone | A secure-context-only API (see Pitfalls).                                                                                                                                             |
| "Could not start phone access on port 4311"              | Another process uses the port. Set `T3_MINI_PHONE_PORT`.                                                                                                                              |
| Server code changes not taking effect                    | The dev server keeps one service and one `RemoteAccess` on `globalThis` across hot reloads. Restart `bun run dev` (this also turns phone access off).                                 |

## Future: HTTPS with Tailscale (not built yet)

Phase 1 is plain HTTP on the local network. This is the planned next step, written so an agent can pick it up. Nothing below exists in the code yet.

### Why

- **Encryption.** Plain HTTP lets anyone watching the network steal a phone's session cookie (security invariant 8). Tailscale traffic is end-to-end encrypted (WireGuard), and `tailscale serve` adds a real HTTPS certificate.
- **Secure context on the phone.** Over HTTPS the phone gets the APIs that are missing today: desktop/phone notifications, the Clipboard API, `crypto.randomUUID()`. The fallbacks in `src/attachments.ts` can stay.
- **Away from home.** Works over cellular or any network where both devices are on the same tailnet, without opening ports.

### Approach (same as t3code)

Reference: t3code's `packages/tailscale/src/tailscale.ts` (`readTailscaleStatus`, `ensureTailscaleServe`, `disableTailscaleServe`, `probeTailscaleHttpsEndpoint`).

1. **Detect Tailscale.** Run `tailscale status --json` (no shell, with a timeout). Use `BackendState === 'Running'`, `Self.DNSName` (the MagicDNS name, e.g. `macbook.tail1234.ts.net.`, strip the trailing dot), and `Self.TailscaleIPs`. If the CLI is missing or not running, hide the option. On macOS the CLI may be `/Applications/Tailscale.app/Contents/MacOS/Tailscale` when `tailscale` isn't on PATH.
2. **Serve the gateway over HTTPS.** When the user turns on a new **Tailscale (HTTPS)** option, start the gateway as today, then run
   `tailscale serve --bg --https=<servePort> http://127.0.0.1:<gatewayPort>`
   (t3code uses `servePort` 8443 by default). Turning it off, and server shutdown, runs `tailscale serve --https=<servePort> off`. MagicDNS and HTTPS certificates must be enabled in the tailnet admin console; surface a clear error if `serve` fails.
3. **Keep pairing.** Being on the tailnet is not enough on its own (shared tailnets, other people's devices). The QR code and session cookie stay exactly as they are; only the URL changes to `https://<DNSName>:<servePort>/pair?code=…`.

### Code changes expected

| Where                           | Change                                                                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New `src/server/tailscale.ts`   | `status()`, `serve(gatewayPort)`, `stopServe()` using `execFile` with argument arrays and timeouts, like `editor.ts`.                                                                                                                                    |
| `remote.ts` → `allowed()`       | Accept `Host` = `<DNSName>:<servePort>` (or bare `<DNSName>` for port 443) in addition to LAN addresses. Requests arrive from `tailscale serve` on loopback, which `isPrivateAddress()` already allows. Origin check becomes `https://<DNSName>[:port]`. |
| `remote.ts` → cookie            | Add `Secure` when the request came through Tailscale (check the host, or the `X-Forwarded-Proto: https` header that `serve` sets). Keep `HttpOnly; SameSite=Lax`. Consider a separate cookie name so HTTP and HTTPS sessions don't mix.                  |
| `remote.ts` → `createPairing()` | Add an `https://<DNSName>…` link; show it first in the UI when available.                                                                                                                                                                                |
| `api.ts`                        | `POST /api/remote` takes `{ enabled, tailscale?: boolean }`; status reports Tailscale availability, DNS name, and serve state. Turning phone access off also stops `serve`. Stop `serve` on process exit too, so it never outlives "off on restart".     |
| `PhoneAccess.tsx`               | A "Use Tailscale (HTTPS)" choice when available, with the HTTPS QR code. Drop the plain-HTTP warning in that mode; keep it for LAN mode.                                                                                                                 |
| Docs                            | Update this file, the README Phone access section, and `AGENTS.md`.                                                                                                                                                                                      |

### Security notes for that work

- **Never use Tailscale Funnel.** Funnel publishes to the public internet. Only `serve` (tailnet-only) is acceptable.
- `serve` adds identity headers (`Tailscale-User-Login`, `Tailscale-User-Name`). They're useful for labeling devices, but **don't use them as the only authentication**, and strip them from anything that doesn't come through `serve` (the gateway already strips client `x-t3-*` headers; do the same for `tailscale-*` on LAN requests).
- Keep every Phase 1 invariant: app on loopback only, off on restart, Mac-only pairing, hashed storage, immediate revocation.
- If the user restricts the tailnet with ACLs, document which devices need access to the Mac on `servePort`.

### Testing

- Unit-test `tailscale.ts` with a stand-in CLI via an env override (like `VSCODE_BIN` in the VS Code test), covering status parsing, `serve`/`off` arguments, missing CLI, and timeouts.
- Gateway tests: accept the Tailscale host and HTTPS origin, set `Secure` on the cookie, still reject unknown hosts and unpaired devices.
- Manual: phone on cellular with Tailscale running, scan the HTTPS QR code, confirm the lock icon, then test notifications, sending, steering, uploads, and revocation.
