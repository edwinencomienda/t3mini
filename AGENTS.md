# Agent guide for t3 mini

A small local web app for running Codex and Claude Code threads on project folders (a mini t3code). The README covers usage; this file is for agents changing the code.

## Commands

```sh
npm run dev        # Vite dev server on http://127.0.0.1:4310
npm test           # vitest (no paid provider calls; providers use fixtures/mocks)
npm run typecheck  # tsc --noEmit
npm run build
npx prettier --write .
```

Run typecheck, tests, and build before committing. Keep the README (and `docs/`) in sync with behavior changes.

## Map

| Area             | Files                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI (single page) | `src/components/Workspace.tsx` (sidebar, chat, composer, dialogs), `AgentSettingsControls.tsx` (agent/model/effort/permission pickers), `DiffPanel.tsx`, `Notifications.tsx` (toasts, Settings), `PhoneAccess.tsx`, `ContextMenu.tsx`, `src/styles.css` |
| Client helpers   | `src/attachments.ts`, `src/notifications.ts`, `src/preferences.ts`, `src/theme.ts`, `src/sound.ts`, `src/diff.ts` (shared with the server)                                                                                                              |
| API              | `src/server/api.ts` (all routes, request checks), `src/routes/api.$.ts`                                                                                                                                                                                 |
| Core             | `src/server/service.ts` (threads, turns, steering/queue, projects, git, diff), `store.ts` (atomic JSON persistence in `.data/`)                                                                                                                         |
| Providers        | `src/server/providers/claude.ts` (Agent SDK), `codex.ts` + `codex-client.ts` (app-server JSON-RPC), `activity.ts` (work-log summaries), `provider-settings.ts`, `models.ts`                                                                             |
| Other server     | `uploads.ts` (attachments), `editor.ts` (Open in VS Code), `folder-picker.ts`, `remote.ts` (phone access gateway)                                                                                                                                       |

## Things to know

- **Restart the dev server after server changes.** The service and the phone-access gateway live on `globalThis` so running agents survive hot reloads; new server code only takes effect after restarting `npm run dev`. Check that no thread is running first (`/api/bootstrap`, status `starting`/`working`/`waiting`), since a restart interrupts running turns.
- **Security posture.** The app listens on loopback only and rejects foreign hosts and cross-origin requests (`checkRequest`). Agents can run arbitrary commands, so any new way in must authenticate. Phone access is the only remote entry point; read `docs/phone-access.md` before touching it.
- **Phones run in an insecure context** (plain HTTP on a LAN address). Don't use `crypto.randomUUID`, `navigator.clipboard`, or other secure-context-only APIs in client code; see `docs/phone-access.md` → Pitfalls.
- **Commands run without a shell** (`execFile` with argument arrays, `--` before paths). Keep it that way.
- **Per-browser state** (theme, drafts, collapsed projects, diff panel state, notification prefs, unread markers) lives in `localStorage`; wrap access in try/catch. Shared state (threads, projects, devices) lives on the server.

## Feature docs

- [docs/phone-access.md](docs/phone-access.md): phone access over the local network (gateway, pairing, security model, pitfalls, testing).
