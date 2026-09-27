---
name: phase-status
description: Report micro-minds build progress from docs/PLAN.md task checkboxes cross-checked against git history. Use when asked "where are we", "what's next", "phase status", "which task is next", or before starting a new PLAN task. Read-only; it never edits PLAN.md or commits.
allowed-tools: Read Grep Glob Bash(git log *) Bash(git status *)
disallowed-tools: Edit Write NotebookEdit
---

# Phase status (read-only)

Produce a short, factual status report for micro-minds. **Do not edit any file, tick any checkbox, or run any git command that changes state.** If something looks wrong, report it and propose the fix; don't apply it.

## Recent history

!`git log --oneline --no-decorate -n 200`

## Steps

1. **Tasks.** Read `docs/PLAN.md` §10. Collect every task line matching `- [ ] <id> …` or `- [x] <id> …`, where `<id>` is `<phase>.<n>` and phase is `0`–`3` or `4a` (for example `0.7`, `2.13`, `4a.3`). Record id, done flag, short title and phase heading. Post-MVP phases (the table after 4a) have no checkboxes; list them as "not started, needs scoping pass".
2. **Commits.** Use the history above (run `git log --format='%h %s%n%b' -n 200` if you need bodies). A commit **explicitly** matches a task when its subject or body contains the task id as a whole token: `(0.7)`, `task 0.7`, `0.7:` or `[0.7]`. Don't match `0.7` inside `10.7` or a version string. A commit **plausibly** matches when it has no id but its conventional-commit scope and subject clearly describe the task (for example `chore: scaffold npm-workspaces monorepo` for 0.1). Label these "inferred" and never count them as explicit.
3. **Cross-check.**
   - Checked task with no explicit or inferred commit → **"ticked, no commit found"**.
   - Commit whose explicit id points at an unchecked task → **"committed, not ticked"**.
   - Task ids referenced in commits that don't exist in PLAN.md → **"unknown task id"**.
   - Run `git status --short`. If the working tree is dirty, say so. In-progress work may explain a mismatch.
4. **Current phase and next task.** The current phase is the earliest phase with an unchecked task. The next task is the first unchecked task in it, in document order. If tasks in that phase are independent (PLAN §14.4 allows parallel subagents when they don't touch the same files), mention up to two other unchecked tasks that could run in parallel, but only when their scopes clearly don't overlap.
5. **Phase gate.** Quote the phase's "Done when" line and say which parts are evidently met or not met from the repo (for example, `.github/workflows/ci.yml` exists; `npm run eval:harness` has a runner at `evals/harness/reviewer/run.ts`). Don't run `npm run check` or any eval; report what you can see.
6. **Open questions.** For each item in PLAN §13, look in `docs/decisions/*.md` (Grep for the topic keywords, for example "run in place", "retention", "first prompt", "2.5D"). Mark it **decided (ADR NNNN)** or **open**. Flag an open question only as "blocking" when the next task depends on it (for example question 5 blocks 3.6).

## Output format

```
## micro-minds status — <date from latest commit>

**Current phase:** Phase N — <title> (<done>/<total> tasks)
**Next task:** N.M <title>
**Could run in parallel:** N.K <title> (or "none")

| Phase | Done | Total |
|---|---|---|
| 0 | 3 | 11 |
…

### Mismatches
- ticked, no commit found: 0.3 node-pty smoke test
- committed, not ticked: 0.5 (a1b2c3d feat(harness): … (0.5))
(or "None.")

### Phase gate — "Done when"
- [met/unmet/unknown] <each clause>

### Open questions (PLAN §13)
- 3 Run in place for non-git folders: open
…
```

Keep it under about 40 lines. State facts; mark any inference as "inferred".
