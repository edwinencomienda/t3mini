# Agent guide for t3 mini

A small local web app for running Codex and Claude Code threads on project folders (a mini t3code). The README covers usage; this file is for agents changing the code.

## Commands

```sh
bun run dev        # Vite dev server on http://127.0.0.1:4310
bun run test       # vitest (no paid provider calls; providers use fixtures/mocks)
bun run typecheck  # tsc --noEmit
bun run build
bunx prettier --write .
```

Run typecheck, tests, and build before committing. Keep the README (and `docs/`) in sync with behavior changes.

## Map

| Area             | Files                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI (single page) | `src/components/Workspace.tsx` (sidebar, chat, composer, dialogs), `AgentSettingsControls.tsx` (agent/model/effort/permission pickers), `DiffPanel.tsx`, `Notifications.tsx` (toasts, Settings), `PhoneAccess.tsx`, `Dictation.tsx` (mic button), `Processes.tsx` (process indicator + logs), `DictationSettings.tsx`, `ContextMenu.tsx`, `Modal.tsx` (every dialog), `ui.tsx` (`Toggle`, `Segmented`), `src/styles.css` |
| Client helpers   | `src/attachments.ts`, `src/notifications.ts`, `src/preferences.ts`, `src/theme.ts`, `src/sound.ts`, `src/diff.ts` (shared with the server)                                                                                                                                                                                                                                                                               |
| API              | `src/server/api.ts` (all routes, request checks), `src/routes/api.$.ts`                                                                                                                                                                                                                                                                                                                                                  |
| Core             | `src/server/service.ts` (threads, turns, steering/queue, projects, git, diff), `store.ts` (atomic JSON persistence in `.data/`)                                                                                                                                                                                                                                                                                          |
| Providers        | `src/server/providers/claude.ts` (Agent SDK), `codex.ts` + `codex-client.ts` (app-server JSON-RPC), `activity.ts` (work-log summaries), `provider-settings.ts`, `models.ts`                                                                                                                                                                                                                                              |
| Other server     | `uploads.ts` (attachments), `editor.ts` (Open in VS Code), `folder-picker.ts`, `remote.ts` (phone access gateway), `dictation.ts` (Deepgram key + transcription), `dictation-stream.ts` (live-dictation WebSocket relay to Deepgram), `tools/` (agent tools: registry, `show_image`, process tools, safe-path checks), `processes.ts` (long-running processes)                                                           |

## Things to know

- **Restart the dev server after server changes.** The service and the phone-access gateway live on `globalThis` so running agents survive hot reloads; new server code only takes effect after restarting `bun run dev`. Check that no thread is running first (`/api/bootstrap`, status `starting`/`working`/`waiting`), since a restart interrupts running turns.
- **Keep the thread view fast.** Typing must not re-render the page: the composer textarea is uncontrolled (`draftText` ref + `hasDraft` flag in `Workspace.tsx`), so don't turn it back into `value={…}` state. Messages render through memoized `MessageView` / `MessageMarkdown` (Markdown parsing is the expensive part, ~100 ms for 80 replies), and `DiffPanel` is memoized with stable props (`closeDiff`). Keep new props to these stable, or they'll re-render on every live update.
- **Don't use `instanceof` on server error classes across modules.** After a hot reload the long-lived service throws errors from an older copy of `service.ts`, so `instanceof HttpError` fails and real 404s/409s turn into 500s. `api.ts` uses `isHttpError()` (checks by name and `status`); follow that pattern for new error types.
- **UI primitives come from [Base UI](https://base-ui.com) (`@base-ui/react`, pinned).** Menus, submenus, and the context menu use `Menu`; dialogs go through `Modal` (`Dialog`); the process list is a `Popover`; tabs, switches (`Toggle`), segmented controls (`Segmented`), and the microphone picker are `Tabs`, `Switch`, `RadioGroup`, and `Select`. Use these for new UI instead of hand-rolled focus, keyboard, or positioning code. Base UI is unstyled: style its parts with classes in `styles.css` and its state attributes (`data-highlighted`, `data-checked`, `data-popup-open`, `data-disabled`). Popups are portaled to `<body>` and share one layer (`z-index: 50`), so whichever opened last is on top; `.workspace` has `isolation: isolate` so they always cover the app.
- **Security posture.** The app listens on loopback only and rejects foreign hosts and cross-origin requests (`checkRequest`). Agents can run arbitrary commands, so any new way in must authenticate. Phone access is the only remote entry point; read `docs/phone-access.md` before touching it.
- **Phones run in an insecure context** (plain HTTP on a LAN address). Don't use `crypto.randomUUID`, `navigator.clipboard`, or other secure-context-only APIs in client code; see `docs/phone-access.md` → Pitfalls.
- **Secrets stay on the server.** The Deepgram key comes from `DEEPGRAM_API_KEY` or `.data/secrets.json` (mode 0600); APIs return only `configured`/`source`/last-4 `hint`, and key management is Mac-only. Never log keys or send them to the browser. Live dictation relays audio through the server (`dictation-stream.ts`) for this reason; its WebSocket is wired into Vite (`vite.config.ts`) and `server.mjs` via an upgrade hook and enforces the same loopback/same-origin rules, refusing paired phones.
- **Commands run without a shell** (`execFile` with argument arrays, `--` before paths). Keep it that way.
- **Per-browser state** (theme, drafts, collapsed projects, diff panel state, notification prefs, unread markers) lives in `localStorage`; wrap access in try/catch. Shared state (threads, projects, devices) lives on the server.

## Feature docs

- [docs/tools.md](docs/tools.md): the agent tool system (`show_image` and how to add tools such as charts).
- [docs/phone-access.md](docs/phone-access.md): phone access over the local network (gateway, pairing, security model, pitfalls, testing, plus the planned Tailscale HTTPS follow-up).
