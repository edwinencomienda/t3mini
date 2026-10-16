# Agent tools (developer guide)

t3 mini can give agents its own tools. `show_image` lets an agent show an image in the chat (a screenshot, a generated chart, a design export), and `show_diagram` lets it draw a Mermaid diagram. The system is built so new tools (charts, tables, diagrams…) are one file each.

Status: proof of concept, working with **Claude** and **Codex**.

## How it fits together

````text
src/server/tools/
  types.ts       defineTool(), ToolContext, ToolError
  paths.ts       resolveAllowedFile(): the shared "inside the project or temp" check
  show-image.ts  the show_image tool
  show-diagram.ts  the show_diagram tool
  rename-thread.ts  the rename_thread tool
  processes.ts   the process tools (start_process…)
  browser.ts     the browser tools (browser_open…, see docs/browser.md)
  index.ts       the registry: every tool, plus Claude naming helpers
src/blocks.ts    Block types: rich content tools add to replies (shared with the client)
src/diagrams.ts  Mermaid diagram type detection (shared by show_diagram and the client)
src/components/blocks.tsx   one renderer per block type
src/components/Diagram.tsx  the Mermaid diagram card (also used for ```mermaid code blocks)
````

1. **A tool** is a definition: `name`, `label` (work log), `description` (what the agent reads), `input` (a zod raw shape: validation and the agent-facing schema in one), `safety`, optional `summarize()` (work log summary), and `run(context, input)`.
2. **The context** gives a tool what it may do to the thread: `cwd` (the project folder), `attach(block)` (add content to the agent's current reply), `saveImage(bytes)` (store an image with the uploads, checked by its bytes), `processes` (this project's long-running processes), and `rename(title)` (retitle this thread, never another). It's built per turn in `service.ts` (`execute()` → `tools`).
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

## Planned

- **`show_chart`:** for data charts beyond Mermaid's pie/xychart: a `chart` block with `{ kind: 'line' | 'bar' | 'pie', title?, labels, series }` (data only, capped in size), rendered by a small chart library or plain SVG.
- **`show_table`**, and a **Settings → Tools** tab to turn tools on or off.
