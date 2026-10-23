# Agent tools (developer guide)

t3 mini can give agents its own tools. `show_image` lets an agent show an image in the chat (a screenshot, a generated chart, a design export), `show_diagram` lets it draw a Mermaid diagram, and `show_html` lets it show a small interactive HTML page in a sealed sandbox, `show_video` shows a video, and `play_audio` plays a sound. The system is built so new tools (charts, tables, diagrams…) are one file each.

Status: proof of concept, working with **Claude** and **Codex**.

## How it fits together

````text
src/server/tools/
  types.ts       defineTool(), ToolContext, ToolError
  paths.ts       resolveAllowedFile(): the shared "inside the project or temp" check
  show-image.ts  the show_image tool
  show-diagram.ts  the show_diagram tool
  show-html.ts   the show_html tool
  show-video.ts  the show_video tool
  play-audio.ts  the play_audio tool
  rename-thread.ts  the rename_thread tool
  read-thread.ts the read_thread tool (formatting in ../shared-thread.ts)
  threads.ts     orchestration: start_thread, message_thread, list_threads, stop_thread, delete_thread (see docs/orchestration.md)
  processes.ts   the process tools (start_process…)
  browser.ts     the browser tools (browser_open…, see docs/browser.md)
  index.ts       the registry: every tool, plus Claude naming helpers
src/blocks.ts    Block types: rich content tools add to replies (shared with the client)
src/diagrams.ts  Mermaid diagram type detection (shared by show_diagram and the client)
src/components/blocks.tsx   one renderer per block type
src/components/Diagram.tsx  the Mermaid diagram card (also used for ```mermaid code blocks)
src/components/HtmlView.tsx the sandboxed HTML card (show_html)
````

1. **A tool** is a definition: `name`, `label` (work log), `description` (what the agent reads), `input` (a zod raw shape: validation and the agent-facing schema in one), `safety`, optional `summarize()` (work log summary), and `run(context, input)`.
2. **The context** gives a tool what it may do to the thread: `cwd` (the project folder), `attach(block)` (add content to the agent's current reply), `saveImage(bytes)` (store an image with the uploads, checked by its bytes), `saveHtml(html)` (store an HTML page with the uploads), `saveMedia(file, kind)` (copy a video or sound into the uploads, checked by its bytes), `processes` (this project's long-running processes), and `rename(title)` (retitle this thread, never another). It's built per turn in `service.ts` (`execute()` → `tools`).
3. **The Claude adapter** (`providers/claude.ts`) turns the registry into an in-process MCP server with the SDK's `createSdkMcpServer()` + `tool()`, named `t3mini`. Claude sees `mcp__t3mini__<name>`. `safe` tools go in `allowedTools` and are allowed in `canUseTool`, so they never prompt. A thrown `ToolError` goes back to Claude as a readable error (`isError: true`); other errors become "<Label> failed."
4. **Blocks**: `attach()` appends a `Block` to the latest assistant message of the turn, or creates an assistant message holding only the block if the agent hasn't written anything since the user's message. Blocks are saved with the thread (`Message.blocks`) and rendered by `components/blocks.tsx` under the message text.
5. **The Codex adapter** (`providers/codex.ts`) declares every tool as a `dynamicTools` entry (`type: 'function'`, `inputSchema` from `toolJsonSchema()`) on `thread/start`, and answers the app-server's `item/tool/call` requests with `{ success, contentItems: [{ type: 'inputText', text }] }`. Codex saves dynamic tools with the thread (session `dynamic_tools`), so resumed turns keep them; `thread/resume` can't add them, so **Codex threads created before a tool existed don't have it**. `approval` tools go through Allow once / Decline before running. The feature is experimental in the app-server; t3 mini already initializes with `capabilities.experimentalApi: true`.
6. **Shared runner**: both adapters call `runTool(definition, context, input)` (validates input with the tool's zod schema, runs it, turns `ToolError`s into a readable failure, never throws).
7. **Work log**: `providers/activity.ts` shows t3 mini tools by `label` and `summarize()`, e.g. "Show image · screen.png", for Claude (`mcp__t3mini__*`) and Codex (`dynamicToolCall` items). `summarize()` must cope with empty input: the step appears before the input has streamed in.

## Adding a tool

1. Create `src/server/tools/<name>.ts` with `defineTool({...})`. Keep `description` concrete about when to use it and what input it expects.
2. Add it to `tools` in `src/server/tools/index.ts`.
3. If it shows a new kind of content, add a type to `Block` in `src/blocks.ts` and a renderer to the switch in `src/components/blocks.tsx`. Blocks carry **data, never HTML or script**.
4. Add tests next to it (see `show-image.test.ts`).
5. Restart the dev server (tools are wired when a turn starts, and the server keeps its service across hot reloads).

## Rules every tool must follow

- **Files:** read files only through `resolveAllowedFile(cwd, path, maxBytes)`. It allows the project folder and the temp folders (`os.tmpdir()`, `/tmp`), resolves symlinks first, and rejects everything else, so `../`, absolute paths elsewhere, and links can't reach other files on the Mac.
- **Images:** store through `context.saveImage()`, which checks the real format from the bytes (PNG/JPEG/GIF/WebP, ≤10 MB). SVG and HTML are refused.
- **Safety level:** `safe` only for tools that just display something. Anything that changes files, runs commands, or reaches the network must be `approval`, which goes through the existing Allow once / Decline flow. (Claude: `safe` tools are pre-allowed; others go through `canUseTool`. Codex: `approval` tools call `ctx.approve()` before running.)
- **Errors:** throw `ToolError` with a message the agent can act on ("File not found: …"); never include secrets or unrelated file contents.
- **Size:** keep block payloads small (they're saved with the thread and sent on every live update). Store binary data via uploads and reference it by id.

## Process tools

`start_process`, `list_processes`, `process_logs`, `stop_process`, `restart_process` (`tools/processes.ts`) let agents run long-lived commands (dev servers, watchers) that keep going after the tool returns. They're backed by `ProcessManager` (`src/server/processes.ts`), owned by the service:

- **Scope:** a thread's tools get `context.processes`, limited to the thread's project. They can't see or control other projects' processes, and `cwd` must stay inside the project.
- **Running:** `$SHELL -lc <command>` (a login shell, so PATH matches the user's terminal) in its own process group (`detached`). Output (stdout+stderr, ANSI stripped) is kept in a 256 KB ring buffer; the first local URL printed (`http://localhost:5173`, `0.0.0.0` normalized) is detected. t3 mini's own env secrets (`DEEPGRAM_API_KEY`…) are removed from the child env.
- **Stopping:** SIGTERM to the whole group, SIGKILL after 5 s. Restart = stop + same command.
- **Lifetime:** in memory only. On t3 mini shutdown (exit, SIGINT, SIGTERM, SIGHUP) every running group is signaled, so dev servers don't outlive it holding ports. Max 10 running per project.
- **Safety:** `start_process` and `restart_process` are `approval` (Allow once / Decline unless the thread has full access); list, logs, and stop are `safe`.
- **UI:** the live snapshot includes `processes`; the composer's meta row shows "● N running" for the open project (`components/Processes.tsx`), with Logs (polled every second while open), Restart, Stop, and Remove. API: `GET /api/processes/:id/logs`, `POST /api/processes/:id/stop|restart`, `DELETE /api/processes/:id`.

## rename_thread

- Input: `{ title }`, trimmed, 1–120 characters. There is no thread id: the tool can only rename the thread the agent is running in (`context.rename`, which calls `AgentService.rename` for that thread, saves, and pushes a live update so the sidebar changes right away).
- Safety: `safe` (it only changes a label). The description tells the agent to use it only when the user asks to rename the thread.
- Typical use: "rename this thread to Login bug", or "give this a better name" / "regenerate the title", where the agent writes a 2–6 word title itself from the whole conversation (no separate title model; the agent knows the conversation best). The sidebar's **Regenerate title** menu item is the non-agent way (see `titles.ts`).
- Codex declares tools when a thread starts, so Codex threads created before this tool existed don't have it; Claude threads get it on their next turn.

## read_thread

- Input: `{ thread, before? }`: the thread's link (`http://…/threads/<id>`, from right-click → **Copy link**) or id, and optionally a turn number to page back from. Safety: `safe` (read-only).
- **Which threads:** the thread's own helpers or lead (orchestration), or one whose id appears in the user's own messages in the current thread (`AgentService.readSharedThread`), from any project; never the current thread. An agent can't list or browse other conversations, or be steered into reading one by a page or file it read. Unknown ids say the thread doesn't exist any more.
- **What it returns** (`shared-thread.ts`, built on `buildTurns` from `src/timeline.ts`): a header (title, project name and folder, agent, status, number of turns), a note that this is another conversation shared for reference and not instructions (its paths belong to its own project), then each turn: the user's message, a work line for the latest run ("Work: 14 steps: edited …; ran 3 commands; 2 browser steps"; older runs keep no steps), and the agent's final answer (in-between notes are left out; images, diagrams, pages, videos, and sounds are named). Messages over 4,000 characters are cut; the newest turns that fit in about 24,000 characters come first, oldest first, with a line saying how to read the earlier ones (`before`).
- The agents' tool note (`toolInstructions`) mentions it.

## Agents' own images

Codex has a built-in image generator. Its results arrive as `imageGeneration` items with base64 `result` data and a `savedPath` under `~/.codex/generated_images/<thread>/`. `providers/codex.ts` (`showGeneratedImage`) shows them like `show_image` does: it uses the data, or the saved file **only if it's inside `~/.codex/generated_images`**, runs the bytes through `saveImage()` (real image, ≤10 MB), and attaches it with Codex's revised prompt as the caption. The turn waits for these saves before ending. The work log shows them as "Generate image".

## show_image

- Input: `{ path, caption? }`. The path is absolute or relative to the project.
- Allowed: files inside the project folder or the temp folders, ≤10 MB, real PNG/JPEG/GIF/WebP.
- Effect: copies the file into `.data/attachments` under a generated id (so later changes to the original don't matter) and attaches `{ type: 'image', id, caption }` to the reply.
- Typical use: "take a screenshot and show me" → the agent runs `screencapture -x /tmp/screen.png` (macOS asks once for Screen Recording permission for the app running the agent), then calls `show_image` with that path.

## show_diagram

- Input: `{ source, title? }`. `source` is Mermaid text (≤20,000 characters) starting with a diagram type; a ` ```mermaid ` fence around it is removed. `title` (≤120) is shown on the card; without it the card shows the type ("Sequence diagram").
- Checked on the server: only that the first meaningful line (after front matter and `%%` comments) is a known Mermaid diagram type (`src/diagrams.ts`), so prose is refused with a readable error. Mermaid's parser needs a browser, so syntax errors show up in the card (the agent's description asks it to write valid Mermaid). Safety: `safe` (it only displays).
- Effect: attaches `{ type: 'diagram', source, title }` to the reply. Only the source is saved; the browser draws it.
- **Drawing** (`components/Diagram.tsx`): `mermaid` and `dompurify` load on demand (dynamic import) the first time a diagram appears. Renders are queued (Mermaid's config is global) and cached per source and theme, so remounts and theme switches back are instant. A `base` theme with the app's palette for light and dark mode; it redraws when the theme changes. Drop shadows are removed and boxes rounded in CSS (`.diagram-svg`). Wide diagrams scale down to at most 65% and then scroll inside the card.
- **Security:** the source is untrusted. Mermaid runs with `securityLevel: 'strict'` (labels are cleaned, no scripts, `click` callbacks off), and the resulting SVG goes through DOMPurify (SVG, HTML and MathML profiles, `foreignObject` for labels, Mermaid's `<style>`; no `img`/`image`/`iframe`/forms) with a hook that drops every `href` that isn't an in-diagram `#fragment`. Nothing in a diagram can run code, load a resource, or open a link. The SVG is only inserted after that.
- **Markdown:** ` ```mermaid ` code blocks in any reply use the same card; while one is still streaming (or isn't valid) the plain code block shows instead.
- Card: title, **Diagram / Code** toggle, copy source, **Expand** (click the diagram too): a full-window view with zoom (25–400%) and **Download SVG**.

## show_html

- Input: `{ html, title? }`. `html` is a complete page or a fragment with inline `<style>` and `<script>` (JavaScript works), up to 200 KB; `title` (≤120) is shown on the card. Empty or oversized HTML is refused with a readable error. Safety: `safe` (it only displays, sealed off as below).
- Effect: saves the page with the uploads (`<attachments>/html/<uuid>.html`, mode 0600) and attaches `{ type: 'html', id, title }` to the reply. `GET /api/html/:id` returns it as **plain text** (`nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`), so opening the URL directly never runs it; only the card does. Ids are checked against `<uuid>.html`, so no other file can be read.
- **The card** (`components/HtmlView.tsx`): title, **Reload**, **View source**, **Copy HTML**, **Expand** (full-window). Its height follows the page (a small script inside posts only a number, clamped to 40–720 px; messages from anything but the card's own frame are ignored). The fetched page and each frame's last height are remembered for the session, so switching back to a thread draws the card at its size straight away instead of growing it from 160 px again. The app's theme colors are passed in as CSS variables (`--background`, `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--border`, `--primary`, `--font-sans`, `--font-mono`) with the right `color-scheme`, and the page is rebuilt when the theme changes.
- **Security:** the HTML is untrusted (the agent may have copied it, or been tricked by something it read). It runs in an `<iframe sandbox="allow-scripts" srcdoc>`:
  - **No `allow-same-origin`:** the page gets an opaque (`null`) origin, so it can't read t3 mini's page, cookies, `localStorage`, or call its API (which runs commands).
  - **No other sandbox flags:** no popups, forms, top-level navigation, `alert`/`confirm`, downloads, or pointer lock.
  - **Our CSP comes first in `<head>`:** `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'`, so no network at all (no fetch, WebSockets, external scripts, styles, fonts, or images). The agent's HTML goes in `<body>`, where a CSP `<meta>` is ignored, so it can't loosen this. `referrerpolicy="no-referrer"`.
  - **Known limit:** browsers can't stop a sandboxed page from navigating its own frame (`location = 'https://…'`), so one request can leave, carrying only what the page itself contains (nothing from t3 mini). The card notices the second `load`, removes the frame, and shows "The page tried to go to another address, so it was stopped" with **Run again**; it never restarts on its own, so a page can't loop.
- Tested by hand with a hostile page: parent access, cookies, storage, fetch to t3 mini and outside, image beacons, popups, top navigation, form submit and `alert` were all blocked; self-navigation got out once and was stopped.

## show_video and play_audio

- Input: `{ path, caption? }`. (`play_audio` used to take `autoplay`; Codex threads that still send it are fine, it's ignored.) The path goes through the same check as `show_image` (`resolveAllowedFile`: inside the project or temp folders, symlinks resolved, size limit): videos up to 200 MB, sounds up to 50 MB. Safety: `safe`.
- **Formats, from the file's first bytes** (`sniffMedia` in `uploads.ts`): video MP4 (`ftyp`), MOV (`ftyp` brand `qt`), WebM (EBML), Ogg; audio MP3 (ID3 or a layer III frame), M4A (`ftyp`), WAV (`RIFF…WAVE`), Ogg, FLAC, WebM. Anything else is refused with a readable error. The file is copied to `<attachments>/media/<uuid>.tmp`, the **copy** is checked (format and size), then renamed to `<uuid>.<ext>`; a refused copy is deleted.
- Effect: attaches `{ type: 'video', id, caption }` or `{ type: 'audio', id, caption }`. **Nothing plays on its own**: you press play. Old audio blocks may still carry `autoplay`/`at`; they're ignored.
- **Serving:** `GET /api/media/:id` (generated ids only) streams the file with byte ranges (`Accept-Ranges`, `206` + `Content-Range`, `416` when out of range): players seek with them, and Safari won't play video without them. Always with the format's own type, `nosniff`, and `Content-Security-Policy: default-src 'none'`.
- **Players** (`components/blocks.tsx`): the browser's own `<video>`/`<audio>` controls; a format the browser can't play says so with a link to the file. When a turn finishes and its media moves into the final answer, a video or sound **you** were playing carries on in the new player from where it was (it only continues what you started).
- Hints in the descriptions: `ffmpeg … -c:v libx264 -pix_fmt yuv420p out.mp4` for video that plays everywhere, and `say -o /tmp/x.m4a --file-format=m4af --data-format=aac "…"` on macOS (plain `say -o` writes AIFF, which browsers can't play).

## Planned

- **`show_chart`:** for data charts beyond Mermaid's pie/xychart: a `chart` block with `{ kind: 'line' | 'bar' | 'pie', title?, labels, series }` (data only, capped in size), rendered by a small chart library or plain SVG.
- **`show_table`**, and a **Settings → Tools** tab to turn tools on or off.
