# 0013. Two token classes: UI token vs per-session hook token

- Status: Accepted. The UI-token delivery part is superseded by [0026](0026-ui-session-bootstrap.md); the hook-token part stands.
- Date: 2026-09-26
- Plan: D13 (PLAN §2)

## Context

Hooks must authenticate to `POST /hooks`, so each agent's environment carries a token
(`MICROMINDS_HOOK_TOKEN`). That environment is visible to the agent and to every subprocess it
runs. If the same token opened the WebSocket, one prompt-injected agent could read other
sessions or type into other agents' terminals via `pty.input`.

## Decision

- **UI token:** random per server start, embedded in the served page, required for the
  WebSocket (first `auth` frame or `Sec-WebSocket-Protocol`, never the query string) and for
  every control HTTP request.
- **Hook token:** random per session (reissued on resume), injected into that session's env,
  accepted only on `POST /hooks` for that `sessionId`. It never grants WS or control access.
- Tokens are compared in constant time. Security tests (task 2.9) assert that session A's
  token can't post events for session B and can't open the WS.

## Consequences

### Positive

- A compromised agent can at worst spoof its own session's events.
- Restarting the server invalidates old UI tokens.

### Negative

- Two token paths to implement and test; old browser tabs need a "Server restarted —
  reload" banner instead of failing silently (PLAN §5.6).
- A malicious agent can still forge events for its own session (accepted risk).

## Revisit when

Never.

## References

- PLAN §5.5, §8, §9 items 2–3, §12
- CLAUDE.md hard rules 3 and 4
