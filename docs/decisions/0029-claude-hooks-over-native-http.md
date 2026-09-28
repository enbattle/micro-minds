# 0029. Claude's hook events arrive over native HTTP hooks, not the relay

- Status: Accepted
- Date: 2026-09-27
- Plan: D29 (PLAN §2); amends D20 (PLAN §2) on where Claude's `session_id` comes from

## Context

PLAN §5.1 prefers a native HTTP hook where a CLI supports one, with the relay
(`packages/hook-relay`) for CLIs that can only run a command, and task 1.4 asked for a measured
choice for Claude Code on Windows. Phase 1 established, for Claude Code 2.1.283 on Windows 11
(`spikes/phase-1/SCENARIOS.md`, `SETTINGS.md`, `npm run spike:latency`):

- **Cost per hook** (30 runs each, after a warm-up):

  | Channel | Median | p90 | Max |
  |---|---|---|---|
  | HTTP hook (loopback POST, in-process client) | 1.4 ms | 2.1 ms | 3.7 ms |
  | Relay, `node relay.ts` started directly | 110 ms | 119 ms | 165 ms |
  | Relay through `cmd /c` (a shell or `.cmd` shim) | 126 ms | 187 ms | 241 ms |
  | Relay with the server down (fail-open path) | 102 ms | 105 ms | 108 ms |

- **Blocking:** only command hooks can be `async` (docs). An HTTP hook blocks the tool until it's
  answered: a reply delayed 4 s delayed the tool by 4 s. A synchronous relay therefore adds about
  110 ms at least twice per tool call; an `async` relay adds no wait but still starts a Node process
  per event and gives up ordering between events.
- **Failure:** an HTTP hook that is refused or answered with 500 fails open, with no added delay.
- **Coverage:** HTTP hooks receive every event Phase 1 recorded except `SessionStart`, which only
  reached command hooks. Every hook payload carries Claude's `session_id`.
- **Token:** an HTTP hook header reads the session token from the environment only through
  `allowedEnvVars`, so the per-session settings file never holds it.

## Decision

1. Claude Code sessions send their hook events to the server as **native HTTP hooks** (`type:
   "http"`) in the per-session settings file, each with `Authorization: Bearer
   $MICROMINDS_HOOK_TOKEN`, `allowedEnvVars: ["MICROMINDS_HOOK_TOKEN"]` and `timeout: 1` (second).
   No relay is registered for Claude.
2. The ingest endpoint (`POST /hooks`, task 2.7) keeps the agent's wait short, because the agent
   waits for its reply on every event. In this order: check the body size, the session and the hook
   token (constant time; 404 for an unknown session and 401 for a bad token, PLAN §9.6, without
   details); then reply at once with an empty 2xx; then parse, store and reduce the event after the
   reply has been sent.
3. **`session.started` comes from the PTY**, when the server spawns the CLI, not from a
   `SessionStart` hook. PLAN §5.3 maps the other hook events as before.
4. **Resume (amends D20):** the adapter captures Claude's `session_id` (the `resumeId`) from the
   first hook payload of the session that carries one, not from `SessionStart`.
5. The relay package stays, fail-open and unused by Claude, for CLIs without native HTTP hooks.
   Task 2.10 (the production relay) is not needed for Claude: it is ticked as not needed in PLAN
   §10, and the relay work moves to the Phase 5 row, where the Gemini and Codex spikes decide
   whether either needs it.

## Consequences

### Positive

- About 1–4 ms per hook instead of about 110 ms, and no process started per tool call.
- One ingest path for Claude, and no relay binary or `.cmd` shim to resolve and ship for the MVP.
- Fail-open holds: a server that is down or failing doesn't delay the agent.

### Negative

- A server that accepts the connection but answers slowly delays every tool call, up to the 1 s
  timeout per hook. Mitigation: decision 2 (only the cheap checks run before the reply), and the
  event store and reducer run after the reply.
- No `SessionStart` payload, so the app learns Claude's `session_id` only when the first hook fires
  (in practice the first prompt). A session that never gets a prompt has nothing to resume, which is
  also the case today.
- The per-session settings file hard-codes the server's port in each hook URL, so the settings file
  is rewritten if the port changes (it's written per session anyway, PLAN §5.2).

## Revisit when

- A Claude Code release sends `SessionStart` to HTTP hooks, or adds `async` for HTTP hooks.
- Measurements on macOS or Linux, or a slower Windows machine, change the comparison.
- Phase 5, for Gemini CLI and Codex CLI (this decision covers Claude only).

## References

- PLAN §2 (D20, D29), §5.1, §5.3, §5.5, task 1.4
- `spikes/phase-1/SCENARIOS.md` (finding 1), `spikes/phase-1/SETTINGS.md`, `spikes/phase-1/latency.ts`
- ADR 0009 (hooks fail open), ADR 0013 (two token classes), ADR 0020 (lightweight resume)
- <https://code.claude.com/docs/en/hooks>
