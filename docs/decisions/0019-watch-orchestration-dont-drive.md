# 0019. The app watches orchestration; it doesn't drive it

- Status: Accepted
- Date: 2026-09-26
- Plan: D19 (PLAN §2)

## Context

Claude Code already orchestrates subagents and routes subagent questions through the parent
session. micro-minds could route prompts, answer questions or hand work between agents, but
that would change agent behavior, duplicate CLI features and expand the security surface.

## Decision

micro-minds visualizes orchestration: subagents appear next to their parent, hands and ?
bubbles land on the right character, and child→parent tethers show structure. Orchestrator
behavior is steered with CLAUDE.md or agent prompts, not app code. Any routing done by the app
(for example cross-provider handoff via an MCP tool exposed by micro-minds) belongs to Phase
6/9. Anything that changes agent behavior needs an ADR (CLAUDE.md hard rule 12).

## Consequences

### Positive

- The app stays an observer, consistent with fail-open hooks (ADR 0009).
- Smaller surface: no app-side routing logic to secure or test in the MVP.

### Negative

- Users can't coordinate agents from the UI beyond typing into terminals.
- The "town of minds" vision waits for Phase 9.

## Revisit when

Phase 9 (orchestration).

## References

- PLAN §1 non-goals, §5.3, §7, §10 (post-MVP table)
- ADR 0009
