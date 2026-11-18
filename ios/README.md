# t3 mini for iPhone

A native iOS app for t3 mini, made to feel like a messaging app: a list of threads, and a chat
for each one. It talks to t3 mini on your computer through the same gateway paired phones use
(Settings → Devices), so it needs nothing new on the server and no account anywhere.

Push notifications: Settings → **Notify me** (and **Send a test**). They come through Apple's push
service from the computer when a thread finishes, fails, or needs you, and tapping one opens the
thread. The computer needs an APNs key once (see docs/phone-access.md → Push notifications). The
thread's name and project are encrypted with a key that never leaves this phone and the computer,
and the notification extension (`T3MiniNotify`) unlocks them on the phone, so Apple can't read them.

Early version. What works: pairing (QR code or pasted link), the thread list (project avatars,
search, pull to refresh, working / needs-you / unread marks), live chat (replies stream in,
threads you opened before show at once), Markdown with tables and code blocks, images (yours and
the agent's, full screen with zoom), `show_html` pages in a sealed web view, status and sub-agent
cards, sending and steering, stop, Allow / Deny, answering the agent's questions, starting a new
thread in a project, a new thread in the same project in one tap (✎ at the top right of a thread, same agent and settings; ⋯ has Agent settings and Stop), a ↓ button to jump back to the latest message, press and hold a thread in the list for New thread in this project, Rename, Regenerate title, Mark as read, Stop, and Delete, choosing the agent, model, reasoning, speed, and permission (the chip above
the message box, and New thread; switching agents mid-thread too), the branch in the header,
sending photos (+, resized to JPEG ≤ 2048 px like the web app), replies grouped into turns like
the web app (the agent's steps fold under "Worked for 2m 10s · 6 steps", the final answer stays open; "Worked for 24s · done 2:00 PM" under the latest turn, "Stopped after…" / "Failed after…" when a run ended early, and a live seconds counter on the working line), a
copy button and the time under each message, and live dictation (the mic: words appear in the
message box as you talk; 16 kHz PCM streamed over the `/api/dictation/stream` WebSocket with
`encoding=linear16&sample_rate=16000`, relayed to the computer's Deepgram key; shown only when
it's set up). Not yet: diagrams, video and sound (they say "open on your computer"),
diffs, editing messages, the camera.

## Connect it

1. On your computer: t3 mini → **Settings → Devices** → **Tailscale (HTTPS)** → turn it on →
   **Connect a device**. (Local network works too, but it's plain HTTP: trusted Wi-Fi only.)
2. On the iPhone: turn Tailscale on, open the app, and **Scan QR code** (or paste the link).

The app keeps the session (30 days, like any paired device) in the iPhone's Keychain. It shows in
Settings → Devices as **iPhone · t3 mini app**; remove it there to cut it off. If the session ends,
the app goes back to the pairing screen.

## Build

Requirements: Xcode 26+, and XcodeGen (`brew install xcodegen`).

```sh
cd ios
xcodegen generate     # creates T3Mini.xcodeproj from project.yml (gitignored)
open T3Mini.xcodeproj # pick an iPhone simulator, ⌘R
```

Tests: `xcodebuild -project T3Mini.xcodeproj -scheme T3Mini -destination 'platform=iOS Simulator,name=iPhone 17' test`.

### Run on your iPhone

One-time: copy `Config/Signing.example.xcconfig` to `Config/Signing.xcconfig` (gitignored) and fill
in your Apple team id and a bundle id you own. Sign in to Xcode → Settings → Accounts, connect the
iPhone and tap **Trust**, and turn on **Settings → Privacy & Security → Developer Mode**. Then:

```sh
scripts/run-on-device.sh          # or: scripts/run-on-device.sh "Pro Max"
```

### Iterating on the app (for agents)

The fast loop after changing the app: test, then put it on the user's iPhone.

```sh
cd ios
xcodegen generate   # only needed when files were added or removed (the script runs it too)
xcodebuild -project T3Mini.xcodeproj -scheme T3Mini -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build test
scripts/run-on-device.sh   # builds, signs, installs and opens it on the phone (about a minute)
```

- **Run the device script outside the sandbox.** It needs `devicectl`, the signing keychain, and
  Apple's servers (automatic provisioning).
- **It needs `Config/Signing.xcconfig`** (gitignored: the user's team id and bundle id). If it's
  missing, ask the user; never commit it or put the team id anywhere in the repo.
- **Signing profiles with push.** Push needs an app-specific profile with the Push Notifications
  capability, which Xcode makes on its own only if it can reach the Apple account. Either an Apple
  ID is signed in to Xcode (Settings → Accounts), or `Config/AppStoreConnect.env` (gitignored, mode 0600) points at an App Store Connect API key: `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID`. The
  script passes it to `xcodebuild -authenticationKeyPath …`. It only names where the key is; never
  copy the key itself into the repo. Without either, the build fails with "No Accounts" and "doesn't
  include the aps-environment entitlement".
- **The phone must be reachable.** `xcrun devicectl list devices` shows it as `connected`. When it
  says `unavailable` (locked, unplugged, asleep), the script stops and says so: ask the user to
  unlock it and keep it plugged in, then run the script again.
- **Reinstalling keeps the pairing** (the session is in the Keychain, which survives updates), so the
  user doesn't scan again. Threads, avatars and pages reload from the computer.
- **You can't see the phone.** After installing, tell the user what changed and what to check, and
  ask for a screenshot when it's visual.
- **Server changes the app depends on** (a new endpoint, say) need the dev server restarted (check
  that no thread is running first, see AGENTS.md); a phone paired with the dev server over
  Tailscale reconnects by itself. The user's main `t3mini` gets them only after
  `bun run install-cli`, so say which one the change is live on.
- **Simulator notes.** On Xcode 27 the Simulator window is DeviceHub
  (`/Applications/Xcode.app/Contents/Applications/DeviceHub.app`). `simctl` works headless
  (`xcrun simctl io "iPhone 17" screenshot shot.png`), and the debug hooks below pair and open a
  thread without typing. If `simctl launch` keeps failing with `FBSOpenApplicationServiceErrorDomain`
  code 4 even after `simctl shutdown all` and a reinstall, stop fighting it and use the device.
- **Clean up after testing:** revoke test devices (`DELETE /api/remote/devices` with `{ "id" }`) and
  turn off access you switched on.

### Testing in the simulator without typing (debug builds only)

```sh
SIMCTL_CHILD_T3MINI_PAIR_LINK='http://<Mac LAN address>:4316/pair?code=…' \
  xcrun simctl launch "iPhone 17" com.example.t3mini
```

pairs with that link at launch (`T3MINI_OPEN_THREAD=<id>` also opens a thread). Use the **dev**
server (port 4016, its gateway on 4316), turn on Local network access there, and get a link from
`POST /api/remote/pair` (see `docs/phone-access.md` → Testing). Revoke the device and turn access
off afterwards.

## How it works

| File                         | What it does                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Services/PairingLink.swift` | Checks a pairing link: `https://` any host, `http://` only private addresses (same rule as `machines.ts`), keeps only scheme/host/port. |
| `Services/APIClient.swift`   | Pairs (form `POST /pair`, reads the session from the 303's `Set-Cookie`), calls `/api/*`, streams `/api/events?patch=1`.                |
| `Services/Keychain.swift`    | The connection (address + session cookie), `AfterFirstUnlockThisDeviceOnly`.                                                            |
| `Services/AppModel.swift`    | App state: threads, projects, the open thread, one live stream that reconnects with backoff.                                            |
| `Models/LiveUpdate.swift`    | Live-update events: missing keys mean unchanged; open-thread patches (`src/thread-patch.ts`); the SSE parser.                           |
| `Features/…`                 | Pairing + QR scanner, thread list, new thread, settings, chat (bubbles, light Markdown, approvals, composer).                           |

Security notes:

- **No new way in.** The app is just another paired device on the existing gateway (`remote.ts`):
  one-time codes, hashed revocable sessions, Tailscale or private-network only. The server only
  learned to name it (`deviceName()`).
- **The session never leaves the paired address.** URLSession stores no cookies and follows no
  redirects; the app adds the cookie itself to requests for that address only.
- **Plain HTTP is allowed only for local addresses** (`NSAllowsLocalNetworking`); Tailscale is HTTPS.
- The debug pairing hook is compiled out of release builds (`#if DEBUG`).
- **Agent HTML pages are untrusted.** `HtmlPageView.swift` loads the server-built page
  (`/api/html/:id/page`, our no-network CSP first) as a string with no base URL, in a
  non-persistent data store, with no navigation, no new windows (tapped http/https links open in
  Safari), and one message handler that only takes the page's height as a clamped number.
