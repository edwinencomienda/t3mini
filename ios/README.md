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
thread in a project, tap the title pill for the thread's details (full title, status and times, agent and settings, folder, branch, open pull request), a new thread in the same project in one tap (✎ at the top right of a thread, same agent and settings; ⋯ has Agent settings and Stop), a ↓ button to jump back to the latest message, press and hold a thread in the list for New thread in this project, Rename, Regenerate title, Mark as read, Stop, and Delete, choosing the agent, model, reasoning, speed, and permission (the chip above
the message box, and New thread; switching agents mid-thread too), the branch in the header,
sending photos (+, resized to JPEG ≤ 2048 px like the web app), replies grouped into turns like
the web app (the agent's steps fold under "Worked for 2m 10s · 6 steps", the final answer stays open; "Worked for 24s · done 2:00 PM" under the latest turn, "Stopped after…" / "Failed after…" when a run ended early, and a live seconds counter on the working line, with the web app's animated Claude/Codex characters: thinking or working while it runs, celebrating for a few seconds when it finishes; the same GIFs from `public/mascots`, off with Reduce Motion or Settings → Appearance → Animations on the computer), a
copy button and the time under each message, and live dictation (the mic: words appear in the
message box as you talk, the words still being worked out muted, with the web's soft rising and falling notes when it starts and stops; 16 kHz PCM streamed over the `/api/dictation/stream` WebSocket with
`encoding=linear16&sample_rate=16000`, relayed to the computer's Deepgram key; shown only when
it's set up), and Mermaid diagrams (`show_diagram`, drawn on the phone; tap for full screen
with pinch to zoom). Images open full screen with smooth pinch, pan, and double-tap zoom.
Agent tools as on the web: the to-do checklist (`update_checklist`; live while the agent works, and kept in view when a turn ends with items left, "2 of 6 left" in its fold line), full status cards (`show_status`: kind, stages, commits, error, link, duration), sub-agent cards (`delegate_task`: agent, access, step, to-do progress, files changed and overlaps, answer or error, and Open its thread), helper threads nested under their lead in the list, video and sound (`show_video`, `play_audio`: downloaded with the session from `/api/media/:id`, played in iOS's own player), and ` ```mermaid ` blocks in replies drawn as diagrams once the block is closed. The web app's sounds, synthesized the same way (`SoundEffects.swift`, no audio files): a chime, marimba, or pop when an agent finishes while the app is open (then the notification banner stays silent, so it isn't played twice), and the dictation notes; Settings → Sounds turns each off and picks the finish sound, and they follow the silent switch. The project's uncommitted changes from ⋯ → Changes (`GET /api/threads/:id/diff`, like the web's Changes panel): files with + / − counts, tap one for its colored lines. Not yet: the agent browser's live preview, running processes, editing messages, the camera.

## Connect it

1. On your computer: t3 mini → **Settings → Devices** → **Tailscale (HTTPS)** → turn it on →
   **Connect a device**. (Local network works too, but it's plain HTTP: trusted Wi-Fi only.)
2. On the iPhone: turn Tailscale on, open the app, and **Scan QR code** (or paste the link).

The app keeps the session (30 days, like any paired device) in the iPhone's Keychain. It shows in
Settings → Devices as **iPhone · t3 mini app**; remove it there to cut it off. If the session ends,
the app goes back to the pairing screen.

## Thread speed

Live updates redraw the open thread several times a second while a reply streams, so the chat
avoids repeat work: parsed Markdown is remembered by its text (`MarkdownCache`), so only the
reply that changed is parsed again; a turn that didn't change is skipped (`TurnView` is
`Equatable`); images are shrunk to screen size straight from the file (`ImageDecode`, ImageIO
thumbnails) and kept decoded, with the full image loaded only in the viewer; the full-screen
viewer zooms with UIKit's scroll view (`ZoomableImage`), not per-frame SwiftUI redraws;
diagrams are drawn once by one hidden web view (`DiagramRenderer`) and remembered; the thread list's sorting, helper grouping, and project lookups are kept by the model and rebuilt only when threads or projects change (not on every redraw), and parsed timestamps are remembered (`RelativeTime.parse`); and only
the latest 20 turns are drawn (Show earlier messages adds more). Opening a thread, the conversation stays hidden until it's at its end (`land()` in `ChatView.swift`: scroll to the bottom and show it the moment it's within 2 points of the end, usually the first frame; a second at most), the way T3 Code's
mobile feed does it, so you never see it lay out and scroll down. After that it stays pinned to
the end while images, diagrams, and replies grow, until you scroll up.

## Build

Requirements: Xcode 26+, XcodeGen (`brew install xcodegen`), and `bun install` at the repo
root: the app bundles Mermaid for diagrams from `node_modules/mermaid/dist/mermaid.min.js`.

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

**Quick checklist to install on the user's iPhone:**

1. Once per machine: `bun install` at the repo root (the app bundles Mermaid from
   `node_modules`), `Config/Signing.xcconfig` and `Config/AppStoreConnect.env` present (both
   gitignored; ask the user if missing, never create them with real values yourself).
2. Test: `cd ios && xcodebuild … test` (below). Fix failures before installing.
3. Install: `ios/scripts/run-on-device.sh`, **outside the sandbox** (in Claude Code: Bash with
   `dangerouslyDisableSandbox: true`). It ends with `✓ t3 mini is running on …`.
4. Server changed too? Restart the dev server (no thread running first, see AGENTS.md).
5. Tell the user what to check on the phone; ask for a screenshot when it's visual.

No cable is needed: the phone installs over the same Wi-Fi. If the script still says the phone
"isn't reachable" after its own wake-up step, see Troubleshooting below before asking the user.

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
- **The phone must be reachable.** `xcrun devicectl list devices` shows it as `connected`. A cable
  isn't needed: a paired phone on the same Wi-Fi works too. Over Wi-Fi it often shows
  `unavailable` just because the wireless link went idle; the script first wakes it
  (`xcrun devicectl device info details --device <id>`). If it still can't reach it (locked,
  asleep, another network, a VPN), it stops and says so: ask the user to unlock the phone and keep
  it awake, then run the script again.
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

### Troubleshooting installs and crashes

- **"isn't reachable" / `unavailable` while the phone is on the same Wi-Fi.** The wireless link
  went idle. The script wakes it once; to do it by hand, wake it and check it's back:

  ```sh
  xcrun devicectl list devices                                   # note the iPhone's identifier
  xcrun devicectl device info details --device <identifier> | grep -E "Device State|Transport"
  # expect "Device State: connected" and "Transport Type: localNetwork" (or wired), then rerun the script
  ```

  Still unavailable: the phone is locked or asleep, on another network, or behind a VPN. Ask the
  user to unlock it and keep the screen on; don't tell them a cable is required.

- **Find the phone on the network:** `dns-sd -B _apple-mobdev2._tcp local.` lists paired devices
  the Mac can see over Wi-Fi (Ctrl-C to stop).
- **The app crashed on the phone.** Pull the crash report instead of guessing:

  ```sh
  xcrun devicectl device info files --device <identifier> --domain-type systemCrashLogs | grep T3Mini
  xcrun devicectl device copy from --device <identifier> --domain-type systemCrashLogs \
    --source T3Mini-<date>.ips --destination /tmp/crash.ips
  ```

  The `.ips` file is a JSON header line, then JSON with `faultingThread` and `threads[].frames`.
  `_dispatch_assert_queue_fail` / `swift_task_checkIsolated` in the trace means a closure the
  compiler took as main-actor code ran on another thread (audio taps, URLSession and WebSocket
  callbacks, notification delegates): mark it `@Sendable` or hop to the main actor inside it.

- **New targets and capabilities** (an app extension, Live Activities, push) are provisioned
  automatically on the next install through `Config/AppStoreConnect.env`; nothing to do in the
  developer portal.
- **`Couldn't find mermaid.min.js` / missing resource at build:** run `bun install` at the repo root.

### Testing in the simulator without typing (debug builds only)

```sh
SIMCTL_CHILD_T3MINI_PAIR_LINK='http://<Mac LAN address>:4316/pair?code=…' \
  xcrun simctl launch "iPhone 17" com.example.t3mini
```

pairs with that link at launch (`T3MINI_OPEN_THREAD=<id>` also opens a thread;
`T3MINI_REOPEN=<id>` opens it, goes back to the list, and opens it again, for checking where a
reopened thread lands: take `xcrun simctl io booted screenshot` after each step, and add a
temporary `onScrollGeometryChange` print in `ChatView` to log content height, visible rect, and
content insets). A session from an earlier run is kept, so later launches need only the thread
variables. When the dev server's phone access is on Tailscale, a pairing link from
`POST /api/remote/pair` works in the simulator as is, with no change to the user's phone. Use the **dev**
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
