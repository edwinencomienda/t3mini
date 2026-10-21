# Worktree threads

A thread can work in its own **git worktree**: a second checkout of the project on its own branch, so several agents can change the same project at once without touching your main checkout (or each other).

## Using it

1. Start a thread in a git project. Under the composer, next to the branch, pick **Local** (the project folder, as before) or **New worktree**. It can only change before the first message.
2. Send. t3 mini creates the worktree first (a **Create worktree t3m/…** step with its time), then the agent runs inside it.
3. The composer shows a **Worktree** badge and the worktree's branch. Git info, the Changes panel, processes, file tools, and Open in VS Code all use the worktree. The thread stays under its project in the sidebar.
4. To bring the work back, ask the agent to commit and push, or open a pull request; the branch and PR link show under the composer as usual.
5. Deleting the thread removes the worktree folder when it has no uncommitted changes. One with changes is kept, and t3 mini says where. The branch always stays, so commits are never lost; delete it yourself when you're done (`git branch -D t3m/…`).

## How it works

- **Where:** `~/.t3-mini/worktrees/<repo>-<hash>/<thread id prefix>`, outside your repository, so nothing needs adding to its `.gitignore`. Set `T3_MINI_WORKTREES_DIR` to put them elsewhere.
- **Branch:** `t3m/<first 8 characters of the thread id>`, created from the project's current `HEAD` (whatever is checked out, including a feature branch) with `git worktree add -b <branch> -- <path> <commit>`. Uncommitted changes in your checkout aren't carried over.
- **A project in a subfolder** of a repository works in the same subfolder of the worktree.
- **`.worktreeinclude`** (the format Claude Code and Codex use): list files in gitignore syntax at the repository's top, e.g. `.env`. Matching files that are also gitignored are copied into each new worktree. Tracked files are never duplicated, symlinks are skipped, nothing is overwritten, and at most 1,000 files are copied. Without the file, nothing is copied.
- **Safety:** commands run without a shell (`execFile`, `--` before paths). t3 mini only removes folders inside its worktrees folder (checked on real paths) and always keeps the branch. A thread whose worktree folder was deleted by hand fails its next turn with a clear message instead of running elsewhere.
- **Code:** `src/server/worktrees.ts` (create, copy, check, remove), `workdir()` in `service.ts` (the folder a thread works in), `ThreadWorktree` in `src/types.ts`.

## Benchmarks

Measured on an M-series Mac (APFS SSD) with local clones of real projects, median of 5 runs, timing each function in `worktrees.ts`: `createWorktree`, `copyIncluded`, `worktreeChanges`, `removeWorktree`. Each clone had a real-size `node_modules` where the project has one, a `.env`, and a `.worktreeinclude` listing `.env`.

| Repository                     | Tracked files | Create (total) | `.worktreeinclude` copy | Changes check | Remove |
| ------------------------------ | ------------- | -------------- | ----------------------- | ------------- | ------ |
| worktree-demo                  | 6             | 34 ms          | 7 ms                    | 7 ms          | 7 ms   |
| t3-mini (+ 33k-file deps)      | 159           | 115 ms         | 58 ms                   | 13 ms         | 12 ms  |
| a larger app (+ 70k-file deps) | 1,749         | 241 ms         | 79 ms                   | 87 ms         | 86 ms  |
| t3code                         | 28,110        | 2.3 s          | 117 ms                  | 0.9 s         | 1.3 s  |

- Creating is mostly `git worktree add` writing out the files, so it grows with the size of the checkout: well under a second for typical apps, a couple of seconds for very large repositories.
- In t3 mini itself, the demo project's first worktree took **53 ms** to create (shown on the step), and a whole Claude turn that checked the folder, branch, and `.env` took about 6 s. Deleting the thread, including removing its worktree, took 24 ms.
- The real cost of a new worktree is usually **dependencies**: a fresh worktree has no `node_modules`. `bun install` in a new t3-mini worktree took **0.83 s** with bun's cache warm; npm, pnpm, or a cold cache take longer.

## Not in this version

Setup scripts (e.g. running `bun install` automatically), several threads sharing one worktree, AI branch names, automatic cleanup of old worktrees, and a merge or "apply to my checkout" screen.

## Pitfalls

- Each worktree needs its own dependencies (don't symlink `node_modules`).
- Two worktrees of the same app running dev servers can clash on ports; ask the agent to use another port.
- Git checks a branch out in one place only; t3 mini's branches are unique, but don't check `t3m/…` out in your main checkout while its worktree exists.
- Submodules and Git LFS files aren't set up in new worktrees.
