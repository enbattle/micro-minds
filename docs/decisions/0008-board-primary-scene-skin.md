# 0008. The board is primary; the scene is a skin

- Status: Accepted
- Date: 2026-09-26
- Plan: D8 (PLAN §2)

## Context

The scene is the memorable part, but a user running several agents needs to see state at a
glance and jump to the right terminal fast. A 3D scene can be hidden, slow on some machines,
or simply not wanted.

## Decision

The board (list of agents and indented subagents with status, activity, tool summary, relative
time, health, telemetry badge), the inbox and the terminal drawer carry the full product.
Phase 3 ships them with no scene at all. The scene is a view over the same `AgentState`, and a
hide-scene toggle keeps board + terminal fully working on their own (PLAN §7, task 4a.1).

## Consequences

### Positive

- The app is useful after Phase 3, before any 3D work.
- All logic lives in the shared reducer and store, not in scene components, which keeps the
  scene replaceable and testable.

### Negative

- Every visual signal needs a board equivalent, so features are built twice (board + scene).

## Revisit when

No trigger; this is a standing product principle.

## References

- PLAN §7, §10 (Phases 3 and 4a), §12
- ADR 0006, 0007
