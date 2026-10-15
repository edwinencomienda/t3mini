# t3 mini

A small, local coding-agent workspace built with **TanStack Start**, React, and TypeScript. Threads live in the left sidebar; the conversation lives on the right. Choose **Codex** or **Claude Code** for each thread.

## Run

Requires Node.js **22.12+** (or a newer supported Node release) and [Bun](https://bun.sh) as the package manager. The app itself still runs on Node; Bun installs dependencies and runs the scripts.

```sh
bun install
bun run dev
```

Open **http://localhost:4310**. Click **Add project** (folder-plus icon in the sidebar header) and choose a folder with **Browse…** (the native macOS folder chooser) or enter an absolute or `~/` path. Adding a project opens a new thread in it with your last agent and settings, so you can send a message right away. Later, click **New thread** (pencil icon) and pick a project to start another. The new-thread dialog starts on the project you were last active in: the open thread's project, otherwise the most recently active one. Enter sends; Shift + Enter inserts a line break. The composer is deliberately simple: **+** attaches images or files, the **model pill** (e.g. “Opus 5.5 Medium”) opens one menu with **Claude | Codex** tabs and a row for each setting: **Model**, **Effort**, and for Codex **Service tier** (Standard or Fast, as reported by Codex). Hover or click a row to open its choices beside the menu (on a phone, they open over it with a back button); picking one updates the row and keeps the menu open, so you can set the model and then the effort in one go. With Provider default, Effort offers the default model's levels. Picking a model in the other agent's tab switches the thread to that agent (only before the first message), and the **lock** button sets the permission mode. Send is the round button on the right; it becomes Stop while the agent works. New threads start with your last choices. Model, effort, and permissions can change between any two messages; the agent can change only until the first message, because a provider session can't move to another agent. Selections are saved per thread and apply to the next message; the settings controls are disabled while an agent is working.

You can keep typing while an agent works: **Enter steers it**. Claude takes the message into the running turn at its next step; Codex receives it via `turn/steer`. If the agent can't take it right then (still starting, between turns, or the provider refuses), the message is marked **Queued** and sent automatically as the next turn. Queued messages from a stopped turn stay in the conversation marked **Not sent**. ⌘⇧O (Ctrl+Shift+O) opens a new thread, ⌘S (Ctrl+S) hides or shows the sidebar (also the panel button in the sidebar header; the choice is remembered), and the **+** next to a project in the sidebar starts a thread there in one click with your last settings. Attach images (up to 10 per message; other formats such as iPhone HEIC are converted, and large photos are scaled to 2048px and about 4 MB on your device before upload) by pasting, dropping them anywhere in the window, or with the **+** button; they're sent to the agent as image input. Dropping any other file inserts its path into your message: the original path when the drag provides one (editors, terminals), otherwise the path of a copy saved under `.data/attachments/files` (browsers don't reveal Finder paths), up to 25 MB. If the project is a git repository, its current branch appears under the composer; it refreshes when you open the thread, after each turn, and when you return to the window. When the remote is on GitHub, click the branch to open it there in a new tab (the branch it tracks, or the repository on `origin` when it doesn't track one yet). The link comes from the git remote URL, so it needs no `gh` CLI, and any credentials in that URL are never sent to the browser. If VS Code is installed (the `code` command, or on macOS the app in `/Applications`), a VS Code button in the chat header opens the thread's project folder in it. Set `VSCODE_BIN` to use a different `code` executable. In a git project, the **Changes** button in the header (or ⌘D / Ctrl+D) opens a panel with the project's uncommitted changes (tracked files against `HEAD`, plus new untracked files) in **Inline** or **Split** view. It refreshes automatically: as the agent finishes each step, and for changes made anywhere else (your editor, a terminal, git) via a lightweight check every 2 seconds while the panel is open and the tab is visible. The refresh button forces a reload. Files start collapsed (click one to open it, or use expand-all), and the files you open are remembered per project; big change sets are capped: at most 200 files are shown (the header says “200 of N files”), and a file with more than 3,000 changed lines shows its counts without its lines. Whether the panel is open is remembered per project. The panel runs full height beside the chat; drag its left edge to resize (double-click to reset, arrow keys work too), and use the collapse/expand-all button in its header. Opening a thread puts the cursor in the composer. When nothing else is focused, typing or pasting anywhere in the window goes straight into the composer, which also works with dictation apps that paste their text.

Right-click a thread in the sidebar (or use its **⋮** button, shown on hover and always on touch screens) to **Rename** it (or double-click its name), copy its project path, or **Delete** it. Renaming works while an agent is running; deleting requires stopping it first. Click a project to collapse or expand it, or use the collapse/expand-all button next to **Projects** (collapsed projects are remembered; search still shows matching threads inside them). Right-click a project to start a thread there, copy its path, or **Remove** it from the sidebar (only once it has no threads; files on disk are never touched).

Use the sun/moon/monitor button at the bottom of the sidebar to cycle between Light, Dark, and System themes, or pick one under **Settings → Appearance**. System follows your OS setting.

When a thread finishes, a soft sound plays (pick Soft chime, Marimba, or Pop, or turn it off, under **Settings → Notifications**). A thread that finishes or fails while you aren't looking at it gets a dot and a bold title in the sidebar until you open it. When a thread finishes, fails, stops, or needs approval, a toast appears in the corner. Click it to open that thread. On your first visit, t3 mini offers to turn on desktop notifications, which fire while the window is in the background. With t3 mini open in several tabs, only the tab you used last sends the desktop notification and plays the sound, and only when you aren't on any t3 mini tab; each tab still shows its own toasts. Enable or disable desktop and in-app notifications at any time from **Settings** (gear icon at the bottom of the sidebar). If you blocked notifications in the browser prompt, allow them in your browser's site settings for localhost, then reload.

t3 mini remembers your last agent, project folder, and per-agent model, effort, and permission choices, plus notification, sound, unread, and theme settings, in this browser (`localStorage`), so new threads start with them.

Install and sign in to the providers you want to use:

```sh
# Codex
npm install -g @openai/codex
codex login

# Claude Code (macOS / Linux)
curl -fsSL https://claude.ai/install.sh | bash
claude
```

Claude runs through the Claude Agent SDK, which includes its own Claude Code runtime and uses your local provider credentials. The **Settings → Agents** section (a warning icon appears in the sidebar footer when a CLI is missing) reports whether a standalone `claude` / `codex` command is available; it does not verify your login or account limits. Restart the server after installing a CLI or changing environment settings.

## What it does

- Saved threads, independent provider sessions, and project folders. Each thread has a `/threads/<thread-id>` URL, so refresh, direct links, and browser Back/Forward preserve selection.
- Provider-supplied model pickers, model-specific effort levels, and saved permission modes.
- Agents can show images in the chat (Claude, and Codex threads created from now on): ask “take a screenshot and show me” or “show me the chart you made”. They use t3 mini's `show_image` tool, which only accepts real image files inside the project or temp folder. See [docs/tools.md](docs/tools.md).
- Agents can rename their own thread: ask “rename this thread to Login bug” or “give this session a better name”. They can't rename other threads. (Codex threads created before this feature don't have it.)
- Agents can run long-lived processes such as dev servers (“start the dev server”): a **● N running** indicator under the composer lists them with their URL, live **Logs**, **Restart**, and **Stop**. They stop when t3 mini stops. Starting one asks for approval unless the thread has full access.
- Streamed Markdown replies and a work log for the latest turn. Each step reads like `Run git status`, `Read src/app.ts`, or `Edit src/styles.css`; click a step to see the full command or edit and its output (long output is trimmed).
- Real provider status: starting, working, waiting for approval, completed, stopped, or failed.
- Explicit **Allow once / Decline** actions when a provider requests tool approval, plus **Stop** for an active turn.
- Live updates over Server-Sent Events, including reconnect snapshots. Switching threads or closing the browser does not stop an agent.
- Recoverable conversations after a server restart. A turn that was active at restart appears as stopped; send a new message to resume its provider session.

Completion comes from the provider's turn result, not from text matching or an inactivity timer. A completed turn means the provider finished responding, not that the requested work was independently validated.

Model catalogs come directly from the local providers and are cached for five minutes. Effort choices follow the selected model’s capabilities (the provider's default model when Provider default is selected). Switching models resets effort to Default. Catalog availability does not guarantee account access. If loading fails, Provider default remains available and the picker offers Retry.

## How it works

```text
Browser → TanStack Start server routes → AgentService
                                       ├─ Codex app-server (JSON-RPC over stdio)
                                       └─ Claude Agent SDK (query + streamed events)
Browser ← Server-Sent Events ← saved thread state
```

Permissions map to each provider’s native modes:

| Mode              | Behavior                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Approval required | Codex starts read-only and requests approvals for untrusted actions; Claude uses its default permission checks.  |
| Auto-accept edits | Codex allows workspace writes; Claude automatically accepts project edits. Other actions may ask for approval.   |
| Auto              | The provider reviews actions automatically. Availability depends on your provider, model, and account policy.    |
| Full access       | Codex removes its sandbox; Claude bypasses normal permission prompts. This permits actions outside your project. |

New threads default to **Claude** (Codex if only Codex is installed) and **Full access**; once you pick something else, your last choice is used instead. Full access lets the agent run any command and edit files outside your project without asking — use it only with projects and machines you trust, and switch to Approval required for anything sensitive. Threads saved before permission modes existed keep their original mode (Codex: Auto-accept edits; Claude: Approval required). Claude reads your user/project/local settings. Existing provider settings can already allow some tools; approvals appear when the provider asks for them. Neither integration installs a plugin. Provider login stays outside this app.

The **Browse…** chooser opens on the Mac running the server. Cancel leaves the current folder unchanged. On other operating systems, enter the project folder path manually.

This first version runs on one local Node process. It binds to loopback and rejects foreign hosts and cross-origin API requests. Phone access (below) is the only way in from another device. There are no tunnels, worktree isolation, checkpoint rollback, or interactive provider question forms. Use a project folder or worktree you intend the agent to edit. Decline unsupported requests or stop the turn and answer with a follow-up message.

## Dictation

The 🎤 button in the composer records your voice and types the transcript at the cursor: click to record, click again to stop (recordings stop on their own after 5 minutes). Transcription uses [Deepgram](https://deepgram.com) (`nova-3` with smart formatting); new Deepgram accounts get free credit, then it's pay-as-you-go.

1. Create an API key at [console.deepgram.com](https://console.deepgram.com).
2. In t3 mini, open **Settings → Dictation**, paste the key, and click **Save**. The server checks it with Deepgram first.
3. Optionally pick a **Microphone** in the same tab (after allowing microphone access once, so the browser shows device names). The choice is remembered per browser and falls back to the system default if that microphone is unplugged.

The key is stored on the Mac in `.data/secrets.json` (owner-only, gitignored) and is never sent back to the browser; Settings shows only its last four characters. Alternatively set `DEEPGRAM_API_KEY` in the environment or in a `.env` file (see `.env.example`), which takes priority. The key can only be viewed or changed on the Mac, not from a paired phone. Audio goes from the browser to the t3 mini server and from there to Deepgram, with Deepgram's model-improvement program opted out (`mip_opt_out=true`).

Browsers only allow the microphone on secure pages, so the button appears on the Mac (`localhost`) but not over plain-HTTP phone access; use your phone keyboard's dictation there.

## Phone access (local network)

Use t3 mini from your phone's browser on the same Wi-Fi. It's off by default and **turns off whenever the server restarts**.

1. On the Mac, open **Settings → Phone access** and turn on **Allow phones on this network**. A phone icon appears in the sidebar footer while it's on.
2. Click **Connect a phone** and scan the QR code with the phone's camera. The code works once and expires after 5 minutes.
3. The phone stays paired for 30 days. Revoke one device or all of them in the same section; revoking cuts open connections immediately.

Phones see the same threads live, and can send, steer, approve, stop, and view changes. Mac-only actions (Browse for a folder, Open in VS Code, managing phone access) are hidden on the phone and refused by the server.

How it works: a gateway listens on port `4311` (set `T3_MINI_PHONE_PORT` to change it) only while phone access is on. It accepts requests only for this Mac's own local-network address, only from private network addresses, only with a paired session cookie (`HttpOnly`, `SameSite=Lax`), and only from its own origin, then forwards them to the loopback-only app marked as remote. Session tokens and pairing codes are stored only as SHA-256 hashes in `.data/devices.json`.

Developer details (architecture, security invariants, pitfalls, tests): [docs/phone-access.md](docs/phone-access.md).

**Security:** traffic is plain HTTP, so use this only on a network you trust (such as home Wi-Fi), never on public or shared Wi-Fi. Anyone on the network who can watch traffic could take over a paired session, and with it agents that can run commands on this Mac. Desktop notifications need HTTPS, so phones get in-app toasts and sound only. macOS may ask once whether to allow incoming connections for `node`. An encrypted HTTPS mode over Tailscale is planned (not built yet); the design is in [docs/phone-access.md](docs/phone-access.md#future-https-with-tailscale-not-built-yet).

## Data and configuration

Conversations are atomically saved to `.data/threads.json`, projects to `.data/projects.json`, and attachments under `.data/attachments/` (all gitignored). Deleting a thread does not delete its attachments. Creating a thread also saves its folder as a project. Provider session IDs are kept so later messages continue the same conversation. Deleting a thread removes its t3 mini history; the provider may retain its own native session history. Back up `.data` if you need it.

| Environment variable | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `T3_MINI_DATA_DIR`   | Override the `.data` directory.                                     |
| `CODEX_BIN`          | Codex executable path; defaults to `codex` on PATH.                 |
| `CLAUDE_BIN`         | Optional Claude Code executable override for the SDK and CLI check. |
| `PORT`               | Production server port; defaults to `4310`.                         |
| `VSCODE_BIN`         | Optional `code` executable used by the Open in VS Code button.      |
| `T3_MINI_PHONE_PORT` | Port for phone access on your local network; defaults to `4311`.    |
| `DEEPGRAM_API_KEY`   | Deepgram key for dictation; overrides the one saved in Settings.    |
| `DEEPGRAM_MODEL`     | Deepgram model for dictation; defaults to `nova-3`.                 |

`bun run dev` and `bun run start` load a `.env` file if present. Use one server process per data directory. Runtime credentials and environment variables are never sent to the browser. Conversations and tool inputs may contain project information, so keep the data directory private.

## Production and checks

```sh
bun run build
bun run start

bun run typecheck
bun run test
```

The production Node server serves the built client, SSR, API routes, and event streams on localhost. This app needs a long-running local Node process with filesystem and CLI access; static-only and edge hosting cannot run these adapters.

Tests cover lifecycle transitions, approvals, stopping, concurrent submissions, disk recovery, request origin checks, and the Codex stdio protocol using a local fixture. No paid provider calls are made by the test suite.

References: [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).
