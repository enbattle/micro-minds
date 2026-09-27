# 0021. Graceful shutdown with a warning

- Status: Accepted
- Date: 2026-09-26
- Plan: D21 (PLAN §2)

## Context

Stopping the server kills every agent (ADR 0020). Doing that abruptly can lose work, leave
orphan CLI processes (especially on Windows, where killing a parent doesn't kill its tree) and
leave SQLite unflushed. Deleting worktrees on exit would destroy uncommitted work.

## Decision

Triggers: Ctrl-C/SIGTERM, "Quit" in the UI, and on Windows console-close (`SIGHUP`) and
Ctrl-Break. With live agents, the UI Quit asks for confirmation and the console prints a
warning (a second Ctrl-C forces shutdown). Sequence: stop accepting new sessions → gracefully
stop every session in parallel (interrupt, grace period, then kill the process tree) → mark
sessions `ended`/`app_shutdown` (resumable) → flush and checkpoint SQLite → delete per-session
settings files → release the lock → exit. A hard deadline (about 10 s) guarantees exit even if
a CLI hangs. Worktrees are kept; nothing is deleted automatically.

## Consequences

### Positive

- Clean, resumable state after every normal shutdown; no orphaned processes in the common case.
- The user is warned before live agents are stopped.

### Negative

- Shutdown takes up to the hard deadline with live agents.
- Hard crashes still skip this path; crash recovery on startup covers them (PLAN §5.6).
- Platform-specific signal and tree-kill handling must be tested on every OS (task 2.11).

## Revisit when

No trigger planned.

## References

- PLAN §5.5 (step 5), §5.6 (shutdown), tasks 2.11, 3.8
- CLAUDE.md hard rule 11
- ADR 0005, 0020
