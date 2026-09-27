# 0012. Worktrees live under `~/.micro-minds/worktrees/<repo-slug>/<sessionId>`

- Status: Accepted
- Date: 2026-09-26
- Plan: D12 (PLAN §2)

## Context

ADR 0005 gives each session a worktree. Nesting worktrees inside the repo (for example
`.worktrees/`) breaks the parent repo's tooling: Vite, Vitest, `tsc` and Biome globs pick up
the nested copies, and Claude Code walks up the directory tree and loads the parent repo's
CLAUDE.md a second time.

## Decision

Worktrees are created at `$MICROMINDS_HOME/worktrees/<repo-slug>/<sessionId>`, where
`MICROMINDS_HOME` defaults to `~/.micro-minds` (and `~/.micro-minds-dev` for `npm run dev`,
PLAN §5.6). `WorktreeManager` owns slug rules and Windows path handling (task 2.5). Per-session
injected settings live in `$MICROMINDS_HOME/sessions/<id>/`, never inside the worktree
(PLAN §5.2).

## Consequences

### Positive

- The user's repo stays clean; its tool globs and CLAUDE.md discovery are unaffected.
- One predictable data directory to document and wipe (PLAN §9 item 7).

### Negative

- Worktrees are out of sight of the repo; the UI must offer "Open folder" and removal.
- Long home paths plus deep repos can hit Windows path-length limits; slug rules must stay short.
- `git worktree prune` must be run for known repos on startup (PLAN §5.6).

## Revisit when

No trigger planned.

## References

- PLAN §5.2, §5.5, §5.6, §9
- ADR 0005
