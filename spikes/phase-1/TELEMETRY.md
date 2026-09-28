# Phase 1 usage telemetry (task 1.8)

Recorded 2026-09-28 with Claude Code **2.1.283** on Windows 11 through `npm run spike:drive --
--telemetry` and the `t-*` runs by name (`drive.ts`), each in a fresh scratch repo, with the hooks
of task 1.2 plus:

- **OpenTelemetry** to the in-process sink at `/otel/<scenario>/<channel>/v1/<signal>` (`sink.ts`),
  OTLP/HTTP JSON, the token in `OTEL_EXPORTER_OTLP_HEADERS`, export intervals of 2 s (metrics) and
  1 s (logs), prompt, response and tool-detail logging off (their defaults), account UUIDs off.
  Captures: `~/.micro-minds-dev/spike/captures/otel-<scenario>.jsonl`.
- **The status line:** `statusline.ts` as the `statusLine` command in our `--settings` only; it
  appends its stdin JSON to `statusline-<scenario>.jsonl` there.

Nothing below was printed from the captures except metric and event names, units, temporality,
attribute keys, enum-like values (model, `type`, `query_source`, `agent.name`) and totals. Scrubbed
fixtures (metrics only, and the status-line JSON): `fixtures/claude/otel-*.jsonl` and
`statusline-*.jsonl` (`npm run spike:scrub`). The decision is ADR 0030.

## Runs

| Run | Scenario | Telemetry configured in | What it answers |
|---|---|---|---|
| `t-qa` | (a) Q&A | process env | Metric names, units, temporality, attributes; status line |
| `t-read-edit` | (b) read + edit | process env | The same with tools (`lines_of_code`, `code_edit_tool.decision`) |
| `t-subagent` | (f) subagent | process env | Whether subagents are distinguishable |
| `t-settings-env` | (a) | our `--settings` `env` block | Whether a settings file's `env` is honored for telemetry |
| `t-user-env` | (a) | process env, plus an endpoint the user added to their user settings | Whether the user's settings override the process env |
| `t-user-settings` | (a) | our `--settings` `env`, plus the same user entry | Whether they override our settings file |
| `t-split` | (a) | `--settings` `env`, token header in the process env only | Whether the two combine, so the file holds no token |
| `t-adr` | (b) | ADR 0030's exact configuration | That it works as decided |

For `t-user-*` the user added `OTEL_EXPORTER_OTLP_ENDPOINT` to their own user settings themselves
(`npm run spike:drive -- --user-telemetry` prints the entry; the driver never reads or writes that
file) and removed it afterwards.

## Results

| Question (PLAN 1.8) | Result |
|---|---|
| Does it export to a local endpoint? | **Yes**, OTLP/HTTP JSON (`application/json`), metrics and logs, with the bearer token header. Every export was authorized. |
| Metric names and units | `claude_code.session.count` (no unit), `claude_code.active_time.total` (`s`), `claude_code.cost.usage` (`USD`), `claude_code.token.usage` (`tokens`), and with edits `claude_code.lines_of_code.count` and `claude_code.code_edit_tool.decision`. Scope `com.anthropic.claude_code`; resource `service.name=claude-code`, `service.version=2.1.283`, `host.arch`, `os.type`, `os.version`. |
| Cumulative or delta? | **Delta** (`aggregationTemporality: 1`), monotonic sums, by default. |
| Model and session attributes | Each cost and token point has `model` and `query_source` (`main`, `subagent`, `auxiliary`), plus `effort` (absent on the Haiku calls); token points add `type` (`input`, `output`, `cacheRead`, `cacheCreation`). `session.id` equals the hooks' `session_id`. Every session used two models: the main one, and `claude-haiku-4-5-20251001` for an `auxiliary` call (the session title); in (f) the main model also made `auxiliary` calls (prompt suggestions). |
| Account data | Every point also carries `user.email`, `user.id` and `organization.id`, even with `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false` (which removes `user.account_uuid`/`user.account_id`). |
| Are subagents distinguishable? | **By type only.** Subagent points have `query_source: "subagent"` and `agent.name: "Explore"`; no metric or log event carries an agent id (`subagent_completed` has `agent_type`). |
| Do the numbers agree? | Metric cost totals equal the `api_request` log events' `cost_usd` totals in every run: 0.117764 (a), 0.155217 (b), 0.343696 (f). |
| Content in logs | `prompt` and `response` attributes are `<REDACTED>`. Logs also describe the setup: `hook_registered`, `plugin_loaded`, `mcp_server_connection`, `managed_settings_resolved`. |
| Does a settings file's `env` work? | **Yes** (`t-settings-env`), for our `--settings` file. (The docs say repository settings are ignored for these variables; not tested.) |
| Can the user's settings override the env? | **Yes: user settings beat the process env** (`t-user-env`: all exports went to the user's endpoint). **Our `--settings` beats user settings** (`t-user-settings`: all exports came to ours). The docs add that managed settings beat everything. |
| Can the user's own OTLP headers override ours? | **Not tested:** the `t-user-*` entry set only the endpoint. ADR 0030 treats header values as untrusted either way (never logged or stored). |
| Can the token stay out of the settings file? | **Yes** (`t-split`, `t-adr`): the settings file's `env` and the process env combine, so the file holds endpoint and switches, and the process env alone holds the header. |
| Status line | Runs on UI redraws. Its JSON has `session_id`, `model`, `workspace`, `version`, `cost` (`total_cost_usd`, durations, lines), `context_window` (tokens, `used_percentage`), `prompt_cache`, `rate_limits` (`five_hour`/`seven_day` `used_percentage` and `resets_at`) and more. Cost is session-cumulative with no per-model split, and the last value missed the final requests: 0.144073 against 0.155217 (b), 0.332212 against 0.343696 (f); equal in (a). |
| Flush on exit | Not measured: every run waited at least 6 s after its last request. |

## Verdict

OpenTelemetry **metrics**, configured in the per-session `--settings` `env` block with the token
header only in the process env: ADR 0030. The status line is not used (cumulative only, no model
split, lags, and it would replace the user's own). Its `rate_limits` are the only observed source
of plan usage limits; the Phase 6 usage panel may use them.
