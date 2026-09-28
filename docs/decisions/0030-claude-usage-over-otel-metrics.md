# 0030. Claude's usage arrives as OpenTelemetry metrics, configured through the per-session settings

- Status: Accepted
- Date: 2026-09-28
- Plan: D30 (PLAN §2); settles the channel D25 left to Phase 1 (PLAN §5.7)

## Context

D25 takes usage and cost only from the CLI's own telemetry and named two channels to verify in
Phase 1: OpenTelemetry export, and the status-line payload as a fallback. Task 1.8 recorded both for
scenarios (a) Q&A, (b) read + edit and (f) subagent with Claude Code 2.1.283 on Windows 11
(`spikes/phase-1/TELEMETRY.md`, fixtures `fixtures/claude/otel-*.jsonl` and `statusline-*.jsonl`):

- **OpenTelemetry** (OTLP/HTTP JSON, `http/json`) works to a loopback endpoint with the token in
  `OTEL_EXPORTER_OTLP_HEADERS`. `claude_code.cost.usage` (USD) and `claude_code.token.usage`
  (tokens; `type` input, output, cacheRead, cacheCreation) are monotonic sums with **delta
  temporality by default**, one data point per `model` and `query_source` (`main`, `subagent`,
  `auxiliary`) per export, and `session.id` equal to the hook payloads' `session_id`. Their totals
  matched the per-request `api_request` log events to the micro-dollar in all three sessions.
- **Subagents** are distinguishable by type only: their points carry `query_source: "subagent"` and
  `agent.name` (for example `Explore`), but no agent id. Two subagents of the same type can't be
  told apart.
- **Account attributes:** every data point carries `user.email`, `user.id` and `organization.id`,
  even with `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false` (which does remove the account UUIDs).
  Prompt and response text in the log events is `<REDACTED>` by default; the log events also
  describe the user's setup (plugins, hook sources, MCP servers).
- **Who wins** (`t-user-env`, `t-user-settings`, with an endpoint the user added to their own user
  settings): the user's settings **override the process env**, so exports went to the user's
  endpoint; our `--settings` file's `env` block **overrides the user's settings**, so exports came
  to us. An `env` value in the settings file is taken verbatim, but the file and the process env
  combine: endpoint and switches in `--settings`, the token header in the process env alone,
  worked (`t-split`). The docs add that managed settings override everything and that repository
  settings are ignored for these variables.
- **The configuration below**, exactly (`t-adr`): metrics only, delta, exports 5.0 s apart, no
  account UUIDs, and the token only in the process env. Every run waited at least 6 s after its
  last request before quitting, so whether the CLI flushes a final export on exit is not known.
- **Status line:** the payload has `cost.total_cost_usd` (session-cumulative, no per-model or
  per-token-type split), `context_window` and `rate_limits` (five-hour and seven-day
  `used_percentage`). It runs only when the UI redraws, so its last value missed the final requests
  (0.144 against 0.155 in (b), 0.332 against 0.344 in (f)), and using it replaces the user's own
  status line in micro-minds sessions.

## Decision

1. **Channel:** usage comes from **OpenTelemetry metrics only**, over OTLP/HTTP JSON to
   `POST /otel/<sessionId>/v1/metrics` (task 2.14), where `<sessionId>` is micro-minds' own
   session id: an export carries no micro-minds id otherwise (the body's `session.id` is Claude's,
   and D29 forbids parsing before the reply), so the route names the session the way the spike's
   per-scenario endpoints did. Logs and traces stay off. The status line is not used.
2. **Injection:** the per-session settings file (PLAN §5.2) gets an `env` block with
   `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=none`,
   `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
   (`http://127.0.0.1:<port>/otel/<sessionId>/v1/metrics`; the session id isn't a secret),
   `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`, `OTEL_METRIC_EXPORT_INTERVAL=5000`
   and `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false`. It outranks the user's settings, so a user's own
   OpenTelemetry endpoint can't divert it: recorded with the generic `OTEL_EXPORTER_OTLP_ENDPOINT`
   on both sides; for this per-signal variable it is inferred (the same precedence per key, and
   OpenTelemetry's per-signal variables beat the generic one), not recorded.
3. **Token:** only in the PTY's process env, as `OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer
   <hook token>` (D13: the session's hook token, valid only on its ingest endpoints). The settings
   file never holds it. Not recorded: what happens when a user's own settings set OTLP headers. If
   theirs replace ours, ingest answers 401 and that session shows usage as unavailable rather than
   a wrong number; either way their headers may reach our endpoint, so decision 4 never logs or
   stores header values.
4. **Ingest (task 2.14):** in the order D29 fixes for `/hooks`: body size; the route's session
   (404 for an unknown one); the token, compared in constant time against **that session's** token
   only (401, no details); then the early reply. The server never logs or stores the value of any
   request header, rejected or not (a user's own collector credentials may arrive there). zod
   parses only `claude_code.cost.usage` and `claude_code.token.usage` data points, and from
   them only the value, `model`, `type`, `query_source` and `agent.name`; every other metric and
   attribute, including `user.email`, `user.id` and `organization.id`, is dropped before anything is
   stored or logged, and no `raw` is kept for telemetry. Each delta point becomes one
   `usage.recorded` event. A cumulative series (temporality 2, possible only if managed settings
   force it) is ignored and logged once; no cumulative→delta converter is built.
5. **Attribution:** per session and per model, as D25 requires. The root agent's `usage` holds the
   whole session, including subagents and auxiliary calls (session titles, prompt suggestions).
   Subagent usage is not attributed to individual subagents: there is no agent id to do it with.
   A per-type breakdown (`agent.name`) is left to the Phase 6 usage panel.

## Consequences

### Positive

- Cost and tokens are the CLI's own numbers, per model, within seconds, and never lag the session's
  end the way the status line does.
- A user's own OpenTelemetry endpoint can't divert micro-minds' usage, and a header conflict, if
  one happens, shows up as "unavailable" instead of wrong totals.
- The route names the session, so the token is checked against one session's token only (HR4),
  before anything is parsed.
- No token at rest in the settings file, and no account identifiers stored.
- Delta temporality removes the cumulative→delta state PLAN §5.7 planned for the ingest layer.

### Negative

- For micro-minds sessions, a user's own collector receives nothing from micro-minds sessions (PLAN
  §5.7 already discloses this); the reverse conflict (their headers) costs micro-minds the usage.
- Managed settings (an organization's policy) override everything; such sessions may show no usage.
  If a policy sets only a metrics endpoint, our process-env header probably still applies (the
  sources combine), sending the session's hook token to that collector. The token only posts to
  that one session's loopback ingest (D13), so this is accepted and recorded in the threat model.
- The usage limits in the status line's `rate_limits` stay unused in the MVP (PLAN §5.7 said they
  weren't observable; they are, but only through the status line).
- Subagents get no usage of their own on the board.

## Revisit when

- Usage from the last few seconds of a session goes missing (task 2.14's end-to-end test or real
  use): then check whether the CLI flushes on exit, and shorten the interval or add a flush wait to
  the graceful stop (PLAN §5.5).
- Claude Code adds an agent id to its metrics (per-subagent usage becomes possible).
- A Claude Code release changes the metric names, the default temporality, or settings precedence
  (the protocol doc records 2.1.283).
- Phase 6 designs the usage panel (per-type breakdown, and whether to show `rate_limits`).
- Phase 5, for Gemini CLI and Codex CLI (this decision covers Claude only).

## References

- PLAN §2 (D13, D25, D30), §5.2, §5.7, tasks 1.8 and 2.14
- `spikes/phase-1/TELEMETRY.md`, `spikes/phase-1/drive.ts` (the `t-*` runs)
- `docs/protocols/claude.md` ("Usage telemetry")
- ADR 0029 (hooks over native HTTP; the early reply)
- <https://code.claude.com/docs/en/monitoring-usage>
