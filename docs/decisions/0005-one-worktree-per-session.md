# 0005. One git worktree per session, stored outside the repo

- Status: Accepted
- Date: 2026-09-26
- Plan: D5 (PLAN §2)

## Context

The app runs several agents at once against the same repository. Agents sharing one working
tree overwrite each other's edits and fight over the index. Git worktrees give each agent its
own checkout and branch cheaply. Where the worktrees live is a separate choice (ADR 0012).

## Decision

Each session gets its own worktree created by `WorktreeManager`:
`git worktree add <MICROMINDS_HOME>/worktrees/<repo-slug>/<sessionId> -b micro-minds/<sessionId>`
(PLAN §5.5). Creation is refused if the target isn't a git repo. The PTY's `cwd` is the
worktree. Worktrees are never deleted automatically: "Remove worktree" is an explicit,
confirmed action that warns about a dirty tree and unpushed or unmerged commits.

## Consequences

### Positive

- Parallel agents can't clobber each other; each session's work is an isolated branch.
- Sessions stay resumable after stop or restart because the worktree persists (ADR 0020).

### Negative

- Worktrees accumulate on disk and as `micro-minds/*` branches until the user removes them.
- Non-git folders are unsupported for now ("run in place" is open question 3).
- Dependencies (for example `node_modules`) must be installed per worktree by the agent/user.

## Revisit when

Never.

## References

- PLAN §5.5, §5.6, §13 (question 3)
- CLAUDE.md hard rules 10 and 11
- ADR 0012, 0020, 0021
