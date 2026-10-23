# The t3mini command

`t3mini` is the production t3 mini: one compiled binary (Bun runtime, built app, page files embedded) that runs in the background on port 4011 with its data in `~/.t3-mini`. The dev server (`bun run dev`, port 4016, `.data`) is a separate copy. Install and update steps are in the README (**Install**); this page lists the commands, how they work, and what's planned.

## Commands today

| Command                        | What it does                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3mini start [--port N]`      | Runs `t3mini serve` in the background (pid in `~/.t3-mini/t3mini.pid`, output in `~/.t3-mini/t3mini.log`) and waits until it answers.                                                                                                                                                                                           |
| `t3mini stop`                  | SIGTERM, then SIGKILL after 10 s. The server exits on the signal and stops agent dev servers and Tailscale serve on its way out.                                                                                                                                                                                                |
| `t3mini restart`               | Stop, then start.                                                                                                                                                                                                                                                                                                               |
| `t3mini status`                | Running or not, address, version, binary, data folder, log, and the repo and commit it was built from.                                                                                                                                                                                                                          |
| `t3mini open`                  | Opens the address in the default browser.                                                                                                                                                                                                                                                                                       |
| `t3mini logs [--lines N]`      | The end of the log (default 100 lines).                                                                                                                                                                                                                                                                                         |
| `t3mini update [--force]`      | Installed from the repo: runs `bun run install-cli` there (`~/.t3-mini/install.json`). Otherwise, or with `--release`: downloads the newest release (or `--version vX.Y.Z`) for this machine, checks it against `SHA256SUMS`, and replaces the binary. Then restarts it unless a thread is running (`--force`: restart anyway). |
| `t3mini import <folder>`       | Copies a t3 mini data folder (e.g. the repo's `.data`) into `~/.t3-mini/data`, only when that's empty and t3mini is stopped.                                                                                                                                                                                                    |
| `t3mini pair [--lan] [--json]` | Lets another computer add this one as a machine: turns on its gateway (Tailscale, or `--lan`) and prints a one-time link and QR (starts t3mini first if needed). See [machines.md](machines.md).                                                                                                                                |
| `t3mini serve [--port N]`      | Runs in the foreground (what `start` runs).                                                                                                                                                                                                                                                                                     |
| `t3mini version` / `help`      | The version, or the command list.                                                                                                                                                                                                                                                                                               |

Settings come from the environment, then `~/.t3-mini/.env` (the binary is compiled without Bun's `.env` and `bunfig.toml` autoloading, so files in the folder it's started from are ignored). `T3_MINI_HOME` moves `~/.t3-mini`; `T3_MINI_BIN_DIR` changes where `install-cli` puts the binary (default `~/.local/bin`).

## Code

- `cli/t3mini.ts`: the commands.
- `cli/compile.ts` (`bun run compile [--all]`): `vite build`, then `dist/client-files.ts` (every page file imported `with { type: 'file' }` so it's embedded as-is), then `bun build --compile` into `dist/bin` (with `--all`: macOS arm64/x64 and Linux x64/arm64). `chromium-bidi` is left out (Playwright's optional Firefox support; t3 mini drives Chromium browsers over CDP).
- `cli/install.ts` (`bun run install-cli [--force]`): compile, copy to `~/.local/bin/t3mini` (staged, then renamed, so a running copy keeps its file), record the repo in `~/.t3-mini/install.json`, restart if running and idle.
- Restart from the app (`src/server/app-update.ts`, `components/AppUpdate.tsx`): `t3mini serve` passes the server its binary's path and which file it started from (inode and modified time, `T3_MINI_BINARY` / `T3_MINI_BINARY_ID`). Installs rename a new file over the binary, so a different file there means an update is waiting: `GET /api/app-update` returns `{ ready, commit?, whenIdle }`, and the sidebar shows a card. `POST /api/app-update/restart` with `{ "when": "now" | "idle" | "cancel" }` runs `t3mini restart --port <port>` from the new binary as a detached process (it stops this server, so it mustn't be its child in the same process group), or waits until no thread is `starting`/`working`/`waiting` (checked every 3 s). Both are Mac only (403 through the phone gateway) and 409 when no update is waiting. The dev server never offers one (no binary).
- `app-server.mjs`: the HTTP server shared by the binary and `server.mjs` (Node).

## Releases

Pushing a version tag publishes a release: `.github/workflows/release.yml` (macOS runner, actions pinned to commits, only `contents: write`) checks that the tag matches `package.json`, runs the typecheck and tests, builds all four binaries with `bun run compile --all`, and attaches them with `SHA256SUMS` to a GitHub release.

```sh
# bump "version" in package.json (e.g. 0.2.0), commit, then:
git tag v0.2.0 && git push origin v0.2.0
```

`install.sh` (`curl -fsSL https://raw.githubusercontent.com/edwinencomienda/t3mini/main/install.sh | sh`) and `t3mini update` on release installs download from the latest release. Files fetched with curl or by t3mini itself aren't quarantined by macOS, so Gatekeeper doesn't block them; a binary downloaded in a browser or sent by AirDrop is (`xattr -d com.apple.quarantine <file>`). Signing and notarizing with an Apple Developer ID would remove that too.

## Planned

- **SSH pairing:** the Mac runs `ssh <host> 't3mini pair --json'` and an `ssh -L` tunnel, so machines without Tailscale can be added with just `user@host` (like T3 Code and the Claude and Codex desktop apps). `t3mini pair --json` already prints the link for this.
- **Machines, step 2:** a merged sidebar and helpers on other machines; see [machines.md](machines.md) → Follow-ups.

Not built yet; listed so the design stays consistent.

| Command                              | Plan                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3mini service install / uninstall` | Start at login: a launchd agent on macOS (`~/Library/LaunchAgents`), a systemd user unit on Linux. Phone and machine access stay off until turned on, as now. |
