# Worktree threads

A thread can work in its own **git worktree**: a second checkout of the project on its own branch, so several agents can change the same project at once without touching your main checkout (or each other).

## Using it

1. Start a thread in a git project. Under the composer, next to the branch, pick **Local** (the project folder, as before) or **New worktree**. It can only change before the first message.
2. Send. t3 mini creates the worktree first (a **Create worktree t3m/…** step with its time), then the agent runs inside it.
3. The composer shows a **Worktree** badge and the worktree's branch. Git info, the Changes panel, processes, file tools, and Open in VS Code all use the worktree. The thread stays under its project in the sidebar.
4. To bring the work back, ask the agent to commit and push, or open a pull request; the branch and PR link show under the composer as usual.
5. Deleting the thread removes the worktree folder when it has no uncommitted changes, at once: the folder is moved into `.trash` inside the worktrees folder (same disk, so it's a rename), git forgets it (`git worktree prune`), and it's deleted in the background. Leftovers from an interrupted delete go the next time a worktree is created. One with changes is kept, and t3 mini says where. The branch always stays, so commits are never lost; delete it yourself when you're done (`git branch -D t3m/…`).

## How it works

- **Where:** `~/.t3-mini/worktrees/<repo>-<hash>/<thread id prefix>`, outside your repository, so nothing needs adding to its `.gitignore`. Set `T3_MINI_WORKTREES_DIR` to put them elsewhere.
- **Branch:** `t3m/<first 8 characters of the thread id>`, created from the project's current `HEAD` (whatever is checked out, including a feature branch) with `git worktree add -b <branch> -- <path> <commit>`. Uncommitted changes in your checkout aren't carried over.
- **A project in a subfolder** of a repository works in the same subfolder of the worktree.
- **`.worktreeinclude`** (the format Claude Code and Codex use): list files in gitignore syntax at the repository's top, e.g. `.env`. Matching files that are also gitignored are copied into each new worktree. Tracked files are never duplicated, symlinks are skipped, nothing is overwritten, and at most 1,000 single files are copied. Without the file, nothing is copied.
- **Dependencies:** list a whole ignored folder, e.g. `node_modules/` or `.venv/`, and it's **cloned** into the new worktree in one go: copy-on-write on macOS (APFS), so it takes no extra disk space and the worktree's copy is independent (installing or changing a package there doesn't touch your checkout). The installed `t3mini` (Bun) clones the whole tree with one `clonefile` call; the dev server (Node) falls back to `cp -c`, which clones file by file and is slower for big folders. Where cloning isn't possible (other systems or disks), a folder is copied file by file only if it fits in the 1,000-file limit, and otherwise skipped: never half a folder. The clone is of your checkout's folder as it is now, so if your checkout's lockfile has uncommitted changes, run an install in the worktree.
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

### Dependencies and removal (after cloning and background removal)

Measured on an M-series Mac (APFS SSD), median of 3 runs, with `.worktreeinclude` listing `.env` and `node_modules/`: a local clone of t3-mini (bun, `node_modules` with 33,686 files / 778 MB) and a small npm app (React, Vite, TypeScript, ESLint; 2,063 files / 82 MB). "Dependencies ready" is creating the worktree plus, before, a warm-cache `bun install --frozen-lockfile` / `npm ci`.

|                                                           | Before                                                    | After (t3mini binary, Bun) |
| --------------------------------------------------------- | --------------------------------------------------------- | -------------------------- |
| `node_modules` in a new worktree                          | 999 of 33,686 files (half-copied by the 1,000-file limit) | complete                   |
| t3-mini: dependencies ready                               | 535 ms (needs an install)                                 | 552 ms (no install)        |
| npm app: dependencies ready                               | 747 ms (needs an install)                                 | 171 ms (no install)        |
| t3-mini: remove a worktree with `node_modules`            | 1,166 ms                                                  | 10 ms                      |
| npm app: remove                                           | 97 ms                                                     | 19 ms                      |
| Delete a worktree thread in the app (end to end, npm app) |                                                           | 33 ms                      |

- With a warm cache, `bun install` is about as fast as the clone, so bun projects mainly gain an always-complete `node_modules`; npm, pnpm, yarn, Python virtualenvs, and cold caches (often tens of seconds) gain the most.
- Under the dev server (Node), the t3-mini clone takes about 3.3 s (`cp -c`, file by file); the npm app's, 237 ms.

## Not in this version

Setup scripts (e.g. running `bun install` automatically), several threads sharing one worktree, AI branch names, automatic cleanup of old worktrees, and a merge or "apply to my checkout" screen.

## Pitfalls

- Each worktree needs its own dependencies (don't symlink `node_modules`).
- Two worktrees of the same app running dev servers can clash on ports; ask the agent to use another port.
- Git checks a branch out in one place only; t3 mini's branches are unique, but don't check `t3m/…` out in your main checkout while its worktree exists.
- Submodules and Git LFS files aren't set up in new worktrees.
