# 0020. Lightweight resume is in the MVP

- Status: Accepted
- Date: 2026-09-26
- Plan: D20 (PLAN §2)

## Context

The server owns every PTY, so a server restart kills every agent. That includes `npm run dev`
watch restarts while developing micro-minds. Without resume, each restart throws away the
agents' conversations. Claude Code can resume a conversation with `claude --resume <id>`.

## Decision

The Claude adapter captures the provider `session_id` from the `SessionStart` hook payload
(never from `~/.claude`, ADR 0004) and stores it as `resumeId` on the SQLite session record.
Resume is offered when the session is `ended` or `interrupted`, a `resumeId` exists and the
worktree still exists. It relaunches `claude --resume <resumeId>` in the same worktree under
the same micro-minds `sessionId`, with a new hook token. Subagents are not restored and prior
hands/? are cleared (PLAN §5.5). The fake provider supports `--resume` so this runs in CI
(task 2.12).

## Consequences

### Positive

- Server restarts, crashes and graceful shutdowns are survivable.
- Worktree + resume id make sessions durable without a separate daemon.

### Negative

- Agents still die on restart; in-flight tool calls and subagents are lost.
- Resume depends on each provider offering a resume flag and exposing its id in hooks.
- Edge cases (worktree gone, no id captured) need explicit UI states.

## Revisit when

A separate PTY-owning process is needed so agents can outlive the server.

## References

- PLAN §5.5 (step 7, session record), §5.6 (dev-mode note), tasks 2.12, 3.8, 3.9
- ADR 0004, 0005, 0021
