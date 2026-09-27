# 0006. Three.js via React Three Fiber, orthographic camera by default

- Status: Accepted
- Date: 2026-09-26
- Plan: D6 (PLAN §2)

## Context

The scene shows agents as characters in an office. We want a 2.5D isometric look by default
but the option of a true 3D view, without maintaining two renderers. The UI is React.

## Decision

The scene uses Three.js through `@react-three/fiber` and `@react-three/drei` in `apps/web`.
The default camera is an orthographic isometric camera with pan and zoom limits; a "3D"
toggle switches to a perspective camera over the same scene graph (tasks 4a.1, 4a.6).
Scene components read `AgentState` and `mood()` only and hold no business logic.

## Consequences

### Positive

- One scene serves both 2.5D and 3D; the default (2.5D vs 3D) can be chosen after Phase 4a
  (open question 2).
- Declarative React components share the zustand store with the board.

### Negative

- WebGL cost on laptop iGPUs; a budget is set (60 fps with 10 agents and 20 subagents) and
  checked with the demo mode in task 4a.7.
- Adds sizeable dependencies (three, R3F, drei) to the web bundle.

## Revisit when

Phase 4a, once the placeholder scene can be judged against the budget and both camera modes.

## References

- PLAN §3 (stack), §7 (scene), §10 Phase 4a, §13 (question 2)
- ADR 0007, 0008, 0022
