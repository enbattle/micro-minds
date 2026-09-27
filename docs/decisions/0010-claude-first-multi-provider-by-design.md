# 0010. Claude-first MVP, multi-provider by design

- Status: Accepted
- Date: 2026-09-26
- Plan: D10 (PLAN §2)

## Context

The goal is to support Claude Code, Gemini CLI and Codex CLI. Only Claude Code is installed on
the dev machine and it has the richest hooks. Building three adapters up front would triple
the protocol-spike risk before the core works; building Claude-only code would make later
providers expensive.

## Decision

The MVP (Phases 0–4a) supports Claude plus a fake provider only. The seams for more providers
exist from Phase 2 (task 2.3): the `ProviderAdapter` interface, a `ProviderRegistry`
(binary resolution including `.cmd`/`.exe`, hook injection strategy, tool-category map) and an
adapter **conformance test suite** every adapter must pass. `ToolCategory`
(`read`/`write`/`exec`/`delegate`/`ask`/`web`/`other`) is the cross-provider contract; the
reducer and UI only see categories. Gemini and Codex arrive in Phase 5, each after its own
protocol spike.

## Consequences

### Positive

- The MVP focuses on one real provider; adding one later means adding an adapter.
- The fake provider makes CI and Playwright tests independent of real CLIs.

### Negative

- Abstractions are designed from one real data point and may need adjustment in Phase 5.
- Gemini/Codex hooks may be too limited; the terminal-only fallback (PLAN §5.4) covers that.

## Revisit when

Phase 5 (multi-provider).

## References

- PLAN §4.1, §5, §10 (Phases 2 and 5), §12
- ADR 0002
