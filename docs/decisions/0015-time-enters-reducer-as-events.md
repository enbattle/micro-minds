# 0015. Time enters the reducer only as events

- Status: Accepted
- Date: 2026-09-26
- Plan: D15 (PLAN §2)

## Context

Health depends on time: "no events for more than 10 min" means possibly stuck, failures decay
out of a 5-minute window, health returns to `ok` after 5 quiet minutes (PLAN §6). If
`reduce()` read `Date.now()`, fixture replays would not be deterministic and the same code
could not run identically on server and client.

## Decision

`reduce(state, event, cfg)` in `packages/shared` is pure and never reads the clock. The
server's `Clock` emits synthetic `clock.tick` events (server-only `EventKind`); the reducer
recomputes staleness and failure-window decay on each tick. All thresholds live in one
exported `Thresholds` object. After sleep/wake, the clock reports the gap and the reducer
resets staleness baselines so agents don't all show "stuck" (PLAN §5.6).

## Consequences

### Positive

- Fixture replays, including staleness and decay scenarios, are deterministic (task 2.1).
- Server and browser run the same reducer and agree on derived state.

### Negative

- Time-based state only changes at tick granularity.
- Tick events add traffic and must be kept out of history noise (retention, UI).

## Revisit when

No trigger planned.

## References

- PLAN §4.2, §4.3, §5.6, §6
- CLAUDE.md hard rule 9
