# Sub-agents (delegate_task)

A thread's agent can hand a task to a **sub-agent**: another agent, Claude or Codex, that works in the same folder with its own context and reports its result back. It's the same idea as Claude's built-in subagents, but it works the same way on both agents, either agent can be the sub-agent, it can run in the background, and every sub-agent's full log is kept.

By default a sub-agent is the **same agent** as its thread. The agent picks the other one only when you ask ("have Codex write the tests").

## Using it

Ask for it in plain words: "Use a sub-agent to research how the API paginates", "Split this up: one sub-agent writes the tests, another updates the docs", or "Have Codex review this file". The agent uses three tools:

| Tool               | What it does                                                                                                                         | Asks first?             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `delegate_task`    | Starts a sub-agent with a task, or follows up with an existing one (`continue`). Waits for its answer, or runs it in the background. | Yes, unless full access |
| `list_delegations` | The thread's sub-agents: id, title, agent, status, files changed, start of the answer.                                               | No                      |
| `stop_delegation`  | Stops one. Files it already changed stay changed.                                                                                    | No                      |

`delegate_task` options:

- `task` (required) and `title` (a short name for its card).
- `agent`: `claude` or `codex`; default: the thread's own agent.
- `wait`: `true` (default) returns the sub-agent's answer as the tool result; `false` returns at once, and its result arrives later as a report message, so the agent can start several and keep working or end its turn.
- `access`: `edit` (default) or `read-only`, which tells the sub-agent to look and report without changing files. It's an instruction, not a restriction: every sub-agent has the same capabilities as its thread (the thread's permission mode, network, commands, and tools), so a read-only task can still run `gh`, call APIs, or run tests.
- `context`: `thread` (default) starts it with a recap of the conversation's recent turns; `none` sends only the task.
- `model`, `effort`: optional. Otherwise the same agent keeps the thread's model and effort, and the other agent uses your last settings for it.
- `continue`: a sub-agent's id, to send it a follow-up. It keeps its memory (its own session).

## What you see

- **A card** in the reply that started it: the agent's icon, its title, what it's doing right now, its to-do progress and run time, and a **Stop** button while it works. When it's done, it folds its changed files and its answer under a toggle. A read-only one says so; a background one is tagged.
- **Its full log**: the card's log button opens the sub-agent's own page, a thread that isn't listed in the sidebar (the breadcrumb leads back to the thread it works for). You can read every step there, and answer it or talk to it directly.
- **Waiting for you**: when a sub-agent needs an approval or an answer, its card says so with an **Answer** link to its page, and the thread shows as waiting in the sidebar.
- **A chip under the composer** while sub-agents work ("2 sub-agents", or "needs you"); its popover lists them, and a row scrolls to its card.
- **Reports**: a background sub-agent's result arrives in the thread as a report card (the same as a helper thread's), which wakes an idle agent.
- While any of its sub-agents works, the thread shows as working in the sidebar, so restarts and agent updates wait for them.

## Sub-agents and helper threads

|          | Sub-agent (`delegate_task`)            | Helper thread (`start_thread`, [orchestration.md](orchestration.md)) |
| -------- | -------------------------------------- | -------------------------------------------------------------------- |
| Lives    | Inside its thread, as a card           | Its own thread in the sidebar                                        |
| Folder   | The **same folder** as its thread      | Its **own worktree** and branch                                      |
| Result   | Tool result (waiting) or a report      | A report                                                             |
| Best for | Work that should land in this checkout | Parallel work you'll merge later                                     |

## Shared folder

Sub-agents and their thread all work in one folder, so:

- Each sub-agent's brief says other agents may be editing too: change only what its task needs, and don't revert or reformat others' changes. A new one is told which files the running ones have changed.
- **Changed files** come from its Edit/Write steps and, in a git project, from comparing `git status` (and each changed file's modified time) at its start and its end, so files changed by shell commands count too. When it may not have been alone (in the background, or with other sub-agents running), only files its own steps mention are credited to it.
- A file two running sub-agents both changed is flagged on the card ("Also changed by another sub-agent") and in the result, so the thread's agent can check for conflicts.
- Work that must not touch the same files belongs in helper threads, which get their own worktrees.

## Limits

- **5 running at once** per thread.
- **No nesting:** a sub-agent can't start sub-agents (or helper threads).
- **No timeout:** a sub-agent runs until it's done. Stopping the thread's turn stops the sub-agents it was waiting for; background ones keep going until you or the agent stop them. Deleting the thread stops and deletes its sub-agents (files they changed stay).
- **Reports count toward the 10 automatic turns** in a row (see orchestration.md), so report → reply loops can't run forever.
- **After a restart**, sub-agents that were running are marked stopped, like any interrupted turn.
- **Codex** threads get their tools when they're created, so Codex threads made before this feature can't delegate.

## How it works

- A sub-agent is a thread with `delegateOf` (its lead), `workIn` (the lead's folder; it never owns a worktree or chat folder, so deleting it can't remove the lead's), and `delegate` (`access`, `background`). `AgentService.list()` and `projects()` leave sub-agents out of the sidebar, search, and project counts; `busy()` still counts them.
- `src/server/delegations.ts`: the brief, the card (`DelegationBlock` in `src/blocks.ts`, built from the sub-agent's thread), changed-file tracking (`changedFiles`, `folderState`, `changedBetween`, `ownChanges`), the result and report text, and `stopLeftoverCards` (used by `store.ts` on load).
- `src/server/tools/delegate.ts`: the three tools, calling `ToolContext.delegates` (`DelegateControl`).
- `AgentService.delegateControl()` (`service.ts`): starts a sub-agent (`create` + `send`, the same paths the UI uses) and adds its card to the lead's reply; waits on `delegateWaits` for `wait: true`. The turn runner keeps the card current on every change (`syncDelegation`) and, when the sub-agent's run ends, settles it (`delegationEnded`): the waiting tool call returns, or a background one reports through `deliverReport`, shared with helper threads.
- Providers: sub-agents run like any thread, with their lead's permission mode (copied when they're created); nothing extra is sandboxed.
- Client: `DelegationCard.tsx` (the card, Base UI `Collapsible`, and `SubAgentChip`, a Base UI `Popover`), drawn through `Blocks`; the timeline keeps running cards in view like status cards. `MessageView` compares blocks one by one (`sameBlocks`), since a card keeps changing after its turn ends.
- Tests: `src/server/delegations.test.ts` (fake agents: waiting and background runs, reports, `continue`, stop, limits, no nesting, overlaps, approvals, deleting the lead; plus the file tracking on a real git folder).
