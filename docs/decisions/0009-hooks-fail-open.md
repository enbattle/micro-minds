# 0009. Hooks fail open

- Status: Accepted
- Date: 2026-09-26
- Plan: D9 (PLAN §2)

## Context

Hooks run inside the agent's control flow. A hook that blocks, errors, writes to stdout or
returns a non-zero code can change what the CLI does or stall it. micro-minds is an observer
(ADR 0019); its server may be stopped, restarting (`npm run dev` watch) or slow.

## Decision

Every hook is non-blocking from the agent's point of view. The relay in
`packages/hook-relay` reads the payload from stdin and the `MICROMINDS_*` env vars, POSTs to
`/hooks` with a hard 300–500 ms timeout, **always exits 0 and writes nothing to stdout**, and
exits immediately if the env vars are missing (PLAN §5.1). Native HTTP hooks are marked
async/non-blocking where the CLI supports it (verified in task 1.3).

## Consequences

### Positive

- If the server is down, agents behave exactly as if the app did not exist.
- No hook can accidentally approve, deny or alter an agent action.

### Negative

- Events can be lost silently while the server is down or slow; the board may be briefly
  wrong until the next event. Staleness is surfaced by `clock.tick` health rules instead.
- The app can't block or answer permission prompts from the UI; the user answers in the
  terminal.
- Relay cold start costs latency on Windows; measured in task 1.4 (Node relay vs HTTP hook).

## Revisit when

Phase 6: an opt-in blocking permission hook would break this decision and needs its own ADR.

## References

- PLAN §5.1, §11 (hook relay tests), task 2.10
- CLAUDE.md hard rule 5
- ADR 0002, 0019
