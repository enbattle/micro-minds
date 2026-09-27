# 0002. Hooks are the structured event channel

- Status: Accepted
- Date: 2026-09-26
- Plan: D2 (PLAN §2)

## Context

The board, inbox and scene need typed facts: which tool is running, when a permission prompt
is up, when a subagent spawns or a turn ends. Scraping terminal output (spinners, ANSI
sequences, alt-screen redraws) is fragile and differs per CLI version. The CLIs expose
lifecycle hooks with JSON payloads.

## Decision

Provider hooks feed the server's `POST /hooks` endpoint, either as a native HTTP hook
(preferred, to be verified for Claude in Phase 1) or through the fail-open relay in
`packages/hook-relay` (PLAN §5.1). Each provider adapter's `normalize(raw)` turns payloads into
`AgentEvent`s (PLAN §4.1); the pure `reduce()` in `packages/shared` derives `AgentState`.
Hooks are injected per session only, never into global CLI config (PLAN §5.2).

## Consequences

### Positive

- Typed lifecycle events (`tool.started`, `attention.permission`, `agent.spawned`, ...) with
  real tool names and ids.
- Recorded payloads become the test backbone (`fixtures/<provider>/*.jsonl`).

### Negative

- Hook formats change between CLI versions. Mitigated by `kind: 'unknown'` (never throw),
  fixture and conformance tests, and recording the CLI version in `docs/protocols/`.
- Providers with weak hooks get only the coarse terminal-only fallback (PLAN §5.4), shown with
  a "limited telemetry" badge.

## Revisit when

Never. Adapters may add other event sources on top of hooks.

## References

- PLAN §4.1, §5.1–5.4, §12
- ADR 0009, 0010
