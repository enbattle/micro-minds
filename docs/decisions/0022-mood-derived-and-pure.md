# 0022. Mood is derived and pure

- Status: Accepted
- Date: 2026-09-26
- Plan: D22 (PLAN §2)

## Context

Characters show a mood (distressed, worried, focused, idle, ...). If the scene computed mood
itself, logic would be duplicated between scene and board, hard to test, and likely to drift.
Users must be able to tell a working agent from an idle one at a glance, without relying on
color.

## Decision

`mood(agent: AgentState): Mood` is a pure selector in `packages/shared`, computed from
activity, health and attention. Rows are evaluated in order and the first match wins, so health
outranks activity (`distressed` > `worried` > `frustrated` > `focused` > `waiting` > `idle` >
`starting` > `done`/`offline`, PLAN §4.4). Attention (hand / ?) is a separate overlay. The
scene only renders the result. Working and idle always differ in animation, icon and board
text. `cheer` is a one-off effect on a long `turn.finished`, not a mood. Tests come first
(task 2.13), including "working vs idle is always distinct".

## Consequences

### Positive

- One tested source of truth for scene and board; the scene stays logic-free.
- The art pass (4b) can restyle moods without touching logic.

### Negative

- New visual states need a shared-package change plus tests, not just a scene tweak.
- The fixed precedence may hide a secondary state (for example working while `notice`).

## Revisit when

Phase 4b (art pass), if richer moods are needed.

## References

- PLAN §4.4, §7, tasks 2.13, 4a.2
- ADR 0007, 0008, 0015
