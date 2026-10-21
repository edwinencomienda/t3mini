# Orchestration: lead and helper threads

One thread (the **lead**) can start other threads (**helpers**) to work in parallel, and the helpers report back to it when they finish. Claude and Codex can both lead, and a lead can hand work to either.

## Using it

Ask a thread to split the work, for example: "Start two helpers: one adds dark mode, one fixes the login bug. Tell me when both are done." The lead uses its tools:

| Tool             | What it does                                                                                                             | Asks first?             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `start_thread`   | Starts a helper with a task (and optional title and agent, Claude or Codex; default: the lead's own agent and settings). | Yes, unless full access |
| `message_thread` | Sends a helper a follow-up (joins its current turn, or starts a new one).                                                | Yes, unless full access |
| `list_threads`   | The lead's helpers: id, title, agent, status, branch, start of the latest reply.                                         | No                      |
| `stop_thread`    | Stops a helper's current turn.                                                                                           | No                      |
| `delete_thread`  | Deletes a helper (stopping it first); its worktree goes too unless it has uncommitted changes; the branch stays.         | Yes, unless full access |
| `read_thread`    | Already existed; a lead can read its helpers (and a helper its lead) without the link being shared.                      | No                      |

- **Helpers are normal threads.** They appear in the sidebar, you can open one and talk to it, and its header shows the lead in the breadcrumb (project / lead / helper).
- **Each helper gets its own worktree** in a git project (see [worktrees.md](worktrees.md)), so helpers never overwrite each other or your checkout. In a project that isn't a git repository, they work in the project folder.
- **The first message a helper gets** is its task, after a line saying which lead it works for and that its final answer is reported back.
- **Reports come back automatically.** When a helper's turn completes or fails, or it starts waiting for your approval or answer, the lead gets a message: the helper's title and id, its agent, its branch with commits and uncommitted files, and its final answer (up to 6,000 characters). It shows in the lead as a card linking to the helper. An idle lead starts a turn to react; a busy one gets it in its current turn (or the next one). A stop isn't reported.
- **Bringing work back:** the lead or you merge the helpers' `t3m/…` branches or open pull requests. There's no merge screen.

## Limits

- **One level:** helpers can't start helpers.
- **Only its own:** a lead can only message, stop, or delete threads it started.
- **5 helpers running at once** per lead.
- **10 automatic turns in a row:** after 10 reports have woken the lead since your last message, further reports still show in the lead (marked "Not sent to the agent") but don't start turns until you write. This stops report → reply → report loops.
- **Approvals stay with you:** a helper inherits the lead's permission mode; when it needs your approval, it waits in its own thread and the lead is told.
- **Codex** threads get their tools when they're created, so Codex threads made before this feature can't lead.

## How it works

- `src/server/tools/threads.ts`: the five tools, calling `ToolContext.threads` (`ThreadControl`).
- `AgentService.threadControl()` (`service.ts`): the lead's view of its helpers (creates them with `create` + `setWorktree` + `send`, the same paths the UI uses). A helper has `parentId`; `ThreadSummary.parentId` carries it to the client.
- `AgentService.reportToLead()`: builds the report message (`Message.report`, a `HelperReport`) and delivers it like a message you'd send: steering a running lead, or starting its next turn; `Thread.autoTurns` counts the automatic turns and resets when you send.
- Client: `ReportCard` (report cards) and the lead link in the header (`Workspace.tsx`).
