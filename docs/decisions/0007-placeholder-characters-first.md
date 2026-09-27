# 0007. Placeholder characters first

- Status: Accepted
- Date: 2026-09-26
- Plan: D7 (PLAN §2)

## Context

Art (rigged characters, animations, lighting, CC0 asset sourcing) is slow and art-bound, while
the value of the app comes from a correct state machine and a usable board. 3D scope creep
delaying usefulness is rated a high-likelihood risk (PLAN §12).

## Decision

Phase 4a uses placeholder visuals only: a capsule colored by provider, a mood face emoji, an
activity icon, simple overlays (hand, ? bubble, red pulse ring, amber stale indicator) and
simple animations that keep working and idle distinct (PLAN §4.4, §7). The art pass is Phase
4b, a post-MVP phase that needs its own scoping pass.

## Consequences

### Positive

- The MVP (Phases 0–4a) is not blocked on assets.
- Every state gets a distinct, testable visual early; demo mode verifies them (task 4a.7).

### Negative

- The MVP looks rough; the "characters" experience is only fully realized in 4b.
- Some scene code may be rewritten when real rigged models arrive.

## Revisit when

Phase 4b (art pass).

## References

- PLAN §4.4, §7, §10 (Phase 4a, post-MVP table), §12
- ADR 0006, 0008, 0022
