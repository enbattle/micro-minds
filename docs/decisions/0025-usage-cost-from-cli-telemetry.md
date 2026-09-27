# 0025. Usage and cost come from the CLI's own telemetry

- Status: Accepted
- Date: 2026-09-26
- Plan: D25 (PLAN §2, §5.7)

## Context

Users want to see how many tokens and roughly how much money each agent is using. The
obvious source, Claude Code's session transcripts, lives under `~/.claude/projects/` and is off
limits (hard rule 1, ADR 0004), even though hook payloads include a `transcript_path`.

The CLIs publish usage themselves:

- **OpenTelemetry export**, enabled by environment variables, with token counts by type and
  cost per model. Gemini CLI and Codex also export OpenTelemetry.
- **The status-line payload** Claude Code passes to a status-line command, which includes total
  cost.

Both are still to be verified against the installed CLI (Phase 1, task 1.8).

Two facts shape how the numbers can be presented:

- On subscription plans the dollar figure is an API-equivalent estimate, not the user's bill.
- What actually limits subscribers is the plan's usage windows, which neither channel reports.

## Decision

- **Source:** each micro-minds session exports OpenTelemetry to our own
  `http://127.0.0.1:<port>/otel` endpoint (OTLP, `http/json`), authenticated with the
  session's hook token. The status line is the fallback. Exactly one channel is used per session,
  so nothing is counted twice. The Phase 1 spike confirms the channel in a follow-up ADR.
- **Numbers:** cost is always the CLI's reported value, never computed from a price table of
  ours. The ingest layer turns cumulative counters into `usage.recorded` delta events; the
  pure reducer only adds.
- **Scope split:**
  - MVP: capture, per-session and per-model totals, board display and a "today" header
    (tasks 1.8, 2.14, 3.10).
  - Phase 6: history, charts, soft budgets and limit warnings.
- **Presentation:** cost is labelled API-equivalent (`≈ $`). Usage limits still surface only
  as `errorClass` errors → red.
- **Privacy:** prompt text and tool-detail logging stay off in the exporter configuration.
  Capture can be disabled in config.

This extends ADR 0013: the per-session hook token is now also accepted on that session's
`/otel/*` endpoints. It still grants no WS or control access.

## Consequences

### Positive

- Usage visibility without touching credentials or transcripts.
- One multi-provider path (OpenTelemetry) that Phase 5 can reuse.
- Cheap to add now, because it rides the event pipeline built in Phase 2.

### Negative

- A second ingest endpoint to secure and test.
- Sessions started by micro-minds send their telemetry to micro-minds, so a personal
  OpenTelemetry collector the user has configured won't receive data from them. This must be
  disclosed in the README.
- Per-subagent attribution may not be possible. The baseline is per session and per model.
- Users may still read ≈cost as their bill. Mitigated by labelling and a tooltip.

## Revisit when

The Phase 1 spike shows OpenTelemetry is unavailable or too coarse, a provider starts
reporting plan-limit usage, or Phase 6 scoping begins.

## References

- PLAN §4.1, §5.7, §8, §9, tasks 1.8, 2.14, 3.10
- ADR 0004 (no credential access), ADR 0013 (token classes), ADR 0015 (time as events)
