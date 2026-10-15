# t3 mini

A small, local coding-agent workspace built with **TanStack Start**, React, and TypeScript. Threads live in the left sidebar; the conversation lives on the right. Choose **Codex** or **Claude Code** for each thread.

## Run

Requires Node.js **22.12+** (or a newer supported Node release) and npm.

```sh
npm install
npm run dev
```

Open **http://localhost:4310**. Click **Add project** and choose a folder with **Browse…** (the native macOS folder chooser) or enter an absolute or `~/` path. Then click **New thread**, pick the project, and send a message. The new-thread dialog starts on the project you were last active in: the open thread's project, otherwise the most recently active one. Enter sends; Shift + Enter inserts a line break. The composer toolbar holds the agent (Claude or Codex), model, effort level, and permission mode. New threads start with your last choices. Model, effort, and permissions can change between any two messages; the agent can change only until the first message, because a provider session can't move to another agent. Selections are saved per thread and apply to the next message; controls are disabled while an agent is working. ⌘⇧O (Ctrl+Shift+O) opens a new thread, and the **+** next to a project in the sidebar starts a thread there in one click with your last settings. When nothing else is focused, typing or pasting anywhere in the window goes straight into the composer, which also works with dictation apps that paste their text.

Right-click a thread in the sidebar to **Rename** it (or double-click its name), copy its project path, or **Delete** it. Renaming works while an agent is running; deleting requires stopping it first. Right-click a project to start a thread there, copy its path, or **Remove** it from the sidebar (only once it has no threads; files on disk are never touched).

Use the sun/moon/monitor button at the bottom of the sidebar to cycle between Light, Dark, and System themes, or pick one under **Settings → Appearance**. System follows your OS setting.

When a thread finishes, a soft sound plays (pick Soft chime, Marimba, or Pop, or turn it off, under **Settings → Notifications**). A thread that finishes or fails while you aren't looking at it gets a dot and a bold title in the sidebar until you open it. When a thread finishes, fails, stops, or needs approval, a toast appears in the corner. Click it to open that thread. On your first visit, t3 mini offers to turn on desktop notifications, which fire while the window is in the background. Enable or disable desktop and in-app notifications at any time from **Settings** (gear icon at the bottom of the sidebar). If you blocked notifications in the browser prompt, allow them in your browser's site settings for localhost, then reload.

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
- Streamed Markdown replies and tool activity for the latest turn.
- Real provider status: starting, working, waiting for approval, completed, stopped, or failed.
- Explicit **Allow once / Decline** actions when a provider requests tool approval, plus **Stop** for an active turn.
- Live updates over Server-Sent Events, including reconnect snapshots. Switching threads or closing the browser does not stop an agent.
- Recoverable conversations after a server restart. A turn that was active at restart appears as stopped; send a new message to resume its provider session.

Completion comes from the provider's turn result, not from text matching or an inactivity timer. A completed turn means the provider finished responding, not that the requested work was independently validated.

Model catalogs come directly from the local providers and are cached for five minutes. Effort choices follow the selected model’s capabilities; choose a model to select its effort. Switching models resets effort to Default. Catalog availability does not guarantee account access. If loading fails, Provider default remains available and the picker offers Retry.

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

This first version runs on one local Node process. It binds to loopback and rejects foreign hosts and cross-origin API requests. It has no remote authentication, tunnels, worktree isolation, checkpoint rollback, attachments, or interactive provider question forms. Use a project folder or worktree you intend the agent to edit. Decline unsupported requests or stop the turn and answer with a follow-up message.

## Data and configuration

Conversations are atomically saved to `.data/threads.json` and projects to `.data/projects.json` (gitignored). Creating a thread also saves its folder as a project. Provider session IDs are kept so later messages continue the same conversation. Deleting a thread removes its t3 mini history; the provider may retain its own native session history. Back up `.data` if you need it.

| Environment variable | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `T3_MINI_DATA_DIR`   | Override the `.data` directory.                                     |
| `CODEX_BIN`          | Codex executable path; defaults to `codex` on PATH.                 |
| `CLAUDE_BIN`         | Optional Claude Code executable override for the SDK and CLI check. |
| `PORT`               | Production server port; defaults to `4310`.                         |

Use one server process per data directory. Runtime credentials and environment variables are never sent to the browser. Conversations and tool inputs may contain project information, so keep the data directory private.

## Production and checks

```sh
npm run build
npm start

npm run typecheck
npm test
```

The production Node server serves the built client, SSR, API routes, and event streams on localhost. This app needs a long-running local Node process with filesystem and CLI access; static-only and edge hosting cannot run these adapters.

Tests cover lifecycle transitions, approvals, stopping, concurrent submissions, disk recovery, request origin checks, and the Codex stdio protocol using a local fixture. No paid provider calls are made by the test suite.

References: [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).
