# Claude Code hook protocol

Tested with Claude Code **2.1.283** on Windows 11, 2026-09-27 and 2026-09-28 (Phase 1, tasks
1.2–1.6). Facts marked **recorded** come from the Phase 1 recordings (`spikes/phase-1/SCENARIOS.md`
and `SETTINGS.md`); facts marked **docs** come from <https://code.claude.com/docs/en/hooks> and
were not seen in a recording. Re-check both when the CLI version changes (the `new-adapter`
checklist).

## Channel and injection

- **Native HTTP hooks** (`type: "http"`) POST each event to `/hooks` (ADR 0029, D29). They block the
  tool until the reply (**recorded**: a 4 s reply delayed the tool 4 s), and only command hooks can
  be async (**docs**), so `/hooks` answers at once and we give each hook a 1 s `timeout` (ADR 0029).
  They fail open on a refused connection and on a 500 (**recorded**, `SETTINGS.md`).
- **`SessionStart` never reaches an HTTP hook** (**recorded**: in none of 9 HTTP runs, including
  after `/compact`; it reached a command hook in every relay run). The docs say every event supports
  HTTP hooks, so this contradicts them. `session.started` comes from the PTY spawn instead (ADR 0029).
- **Injection:** a per-session settings file passed with `claude --settings <file>` (PLAN §5.2). It
  **merges** with both the project's `.claude/settings.json` and the user's own settings
  (**recorded**: a project hook and ours both fired; so did a hook the user added to their user
  settings, and ours). The driver never read the user's settings (hard rule 1): the user added
  the hook themselves (`SETTINGS.md`, `x-user-merge`).
- **Token:** the header can read it from the environment, `Authorization: Bearer
  $MICROMINDS_HOOK_TOKEN` with `allowedEnvVars: ["MICROMINDS_HOOK_TOKEN"]`, so the settings file
  holds no token. Without `allowedEnvVars` every request was rejected with 401 (**recorded**); the
  docs say an unlisted variable becomes an empty string (**docs**).

## Common payload fields

Every recorded payload has `hook_event_name`, `session_id`, `cwd`, `transcript_path` and
`scratchpad_dir`; most also have `prompt_id`, `permission_mode` (`auto`, `default` recorded) and
`effort: { level }`.

- **`session_id`** is the provider session id, stable for the whole session, including across
  `/compact`. It is the `resumeId` for `claude --resume` (D20), taken from the first payload.
- **`transcript_path`** and **`agent_transcript_path`** are never opened (hard rule 1), and are
  scrubbed from the stored `raw`.
- **Subagent events** (their tool events, `SubagentStart`, `SubagentStop`) add `agent_id` and
  `agent_type`. Main-agent events have neither.

## Event mapping

This is PLAN §5.3, confirmed. "Payload fields" lists the fields the adapter reads, beyond the common
ones.

| Hook | Payload fields | → AgentEvent | Source |
|---|---|---|---|
| `SessionStart` | `source` (`startup` recorded; docs: `resume`, `clear`, `compact`, `fork`), `model` | Not received over HTTP. `session.started` comes from the PTY spawn. | recorded |
| `UserPromptSubmit` | `prompt` | `prompt.submitted`; `text` = scrubbed, truncated `prompt`. Also sent, with no user typing, when a background subagent's result comes back (finding 6 below). | recorded |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | `tool.started` with `tool.category` from the table below, `useId` = `tool_use_id`. `AskUserQuestion` → `attention.question`. | recorded |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | `tool.finished`. Paired with its `PreToolUse` by `tool_use_id` (every recorded pair matched). | recorded |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `error` (a string), `is_interrupt`, `duration_ms`; no `tool_response` | `tool.failed`, paired with its `PreToolUse` by `tool_use_id`. A shell command that exits non-zero comes here (finding 2). | recorded |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_suggestions`; **no `tool_use_id`** | `attention.permission`, except `tool_name: "AskUserQuestion"` → `attention.question` (finding 5). | recorded |
| `Notification` | `notification_type`, `message` | `idle_prompt` → `attention.idle` (**recorded**, sent 60 s after the session went idle). `elicitation_dialog` → `attention.question` (docs). `permission_prompt` → `unknown`: `PermissionRequest` already raised the hand, and a notification can't tell a question dialog from a permission prompt. Any other type → `unknown`. | recorded / docs |
| `SubagentStart` | `agent_id`, `agent_type` | `agent.spawned`: `agentId` = `agent_id`, parent = the root agent. | recorded |
| `SubagentStop` | `agent_id`, `agent_type`, `last_assistant_message`, `background_tasks` | `agent.finished`. May arrive for an agent that never sent `SubagentStart` (empty `agent_type`); that must never create or end a visible subagent (finding 6). | recorded |
| `Stop` | `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` | `turn.finished` for the root agent, even while background subagents still run (`background_tasks` non-empty). | recorded |
| `StopFailure` | `error_type`: `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown` | `turn.failed` with `errorClass`: `rate_limit` and `overloaded` → `rate_limit`; `authentication_failed`, `oauth_org_not_allowed`, `cloud_credential_error` → `auth`; `billing_error`, `account_on_hold` → `budget`; anything else → `other`. | docs |
| `PreCompact` | `trigger` (`manual` recorded; docs: `auto`) | `context.compacting` | recorded |
| `SessionEnd` | `reason` (`prompt_input_exit` recorded; docs: `clear`, `resume`, `logout`, `other`) | `session.ended` (the PTY exit is still the authority for the session record, §5.5) | recorded |
| any other | — | `unknown`, `raw` kept (hard rule 7) | — |

**Attribution:** an event with `agent_id` belongs to that subagent (`agentId` = `agent_id`,
`parentAgentId` = the root); without it, to the root agent (`agentId` = our `sessionId`).

### Tool categories

| `tool_name` | Category | Source |
|---|---|---|
| `Read`, `Glob`, `Grep` | `read` | `Read` recorded; `Glob`, `Grep` docs |
| `Edit`, `Write`, `NotebookEdit` | `write` | `Edit`, `Write` recorded; `NotebookEdit` docs |
| `Bash`, `PowerShell` | `exec` | `Bash` recorded; `PowerShell` docs |
| `Agent`, `Task` | `delegate` | `Agent` recorded; `Task` (the older name) PLAN §5.3 |
| `AskUserQuestion` | `ask` | recorded |
| `WebFetch`, `WebSearch` | `web` | docs |
| `SubagentHandback`, MCP tools (`mcp__*`), anything else | `other` | `SubagentHandback` recorded; the rest by default |

## Findings the adapter and reducer must handle

Each cites its finding in `spikes/phase-1/SCENARIOS.md` ("S1" and so on), where the recording is;
finding 4 comes from the payload fields of the recordings instead.

1. **No `SessionStart` over HTTP** (S1, above). Start and the resume id come from the PTY spawn
   and the first payload.
2. **A failed shell command is a tool failure** (S3): a command that exits non-zero gives
   `PostToolUseFailure(Bash)` with an `error` string (the docs' `error_type` and `error_message`
   did not appear). A wrapper hides it: the first recording's agent ran
   `node scripts/fail.js; echo "EXIT: $?"`, which exits 0 and gave `PostToolUse(Bash)`, whose
   `tool_response` (`stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`) has no exit
   code. So `tool.failed`, and
   PLAN §6's failure window, see only commands whose own exit is non-zero.
3. **Declining a permission prompt ends the turn silently** (S4): after `PermissionRequest` comes no
   `PostToolUse` and no `Stop`. The hand stays raised until the next `prompt.submitted`, the
   `idle_prompt` notification (→ `attention.idle`) or `session.ended` (§4.3). The notification is
   inferred: the declined run ended before one could arrive; in the compaction run it came 60 s
   after the session went idle.
4. **`PermissionRequest` has no `tool_use_id`.** It belongs to the latest unfinished `PreToolUse` of
   the same `tool_name` and agent, if the adapter needs the link.
5. **`AskUserQuestion`'s dialog is a `PermissionRequest(AskUserQuestion)`** (S5), even with
   `--allowedTools AskUserQuestion`; there's no separate approval. It maps to `attention.question`.
6. **Subagents can run in the background** (S6). `PostToolUse(Agent)` returns at once with
   `tool_response.status: "async_launched"`, `isAsync: true` and `agentId` equal to the subagent's
   `agent_id`, so the `delegate` tool finishing doesn't mean the child is done. The main `Stop` can
   come before the child finishes. The result comes back as `PreToolUse`/`PostToolUse
   (SubagentHandback)` from the subagent, then a `UserPromptSubmit` that no user typed; the
   subagent's own `SubagentStop` follows. Other `SubagentStop`s arrive from agent ids that never
   sent `SubagentStart` and never used a tool (empty `agent_type`): during a subagent's tool calls,
   after a later prompt, at the end of a session, and after `/compact`.
   `Stop.background_tasks[]` (`id`, `type`, `agent_type`, `status`, `description`) lists the
   running children; its `id` is the subagent's `agent_id`.
7. **An interrupt (Ctrl-C) and a killed process send nothing** (S7): no `PostToolUse`, no `Stop`.
   The `SessionEnd` in the Ctrl-C scenario came from quitting the CLI afterwards. Detect both from PTY
   state and the process exit (§5.4, §5.5).
8. **Compaction** (S8) sends `PreCompact`, then a `SubagentStop` from an unseen agent (as in 6). No
   `SessionStart` follows over HTTP, and `session_id` doesn't change.

## Not yet covered

- **Recorded:** never `PostToolUseFailure` for a tool other than `Bash`, `StopFailure`, `Notification` other than `idle_prompt`,
  a `SessionStart` with `source` other than `startup`, or `PreCompact` with `trigger: "auto"`.
  Their rows above follow the docs; a fixture replaces each when one is recorded (the
  `record-fixture` skill).
- **Usage telemetry:** whether the CLI flushes a final export on exit (every run waited at least
  6 s after its last request).

## Usage telemetry

Recorded in task 1.8 (`spikes/phase-1/TELEMETRY.md`); the decision is ADR 0030 (D30).

- **Channel:** OpenTelemetry metrics over OTLP/HTTP JSON (`http/json`) to a loopback endpoint, with
  the bearer token in the OTLP headers (**recorded**). The status line is not used.
- **Metrics** (scope `com.anthropic.claude_code`, **recorded**): `claude_code.cost.usage` (`USD`)
  and `claude_code.token.usage` (`tokens`, `type`: `input`, `output`, `cacheRead`,
  `cacheCreation`) are the ones ingest reads; also `session.count`, `active_time.total` (`s`),
  `lines_of_code.count` and `code_edit_tool.decision`. All are monotonic sums with **delta**
  temporality (`aggregationTemporality: 1`) by default.
- **Attributes** (**recorded**): `model` and `query_source` (`main`, `subagent`, `auxiliary`) on
  every cost and token point, `effort` on most, `agent.name` (the subagent type, for example
  `Explore`) on subagent points; `session.id` equals the hooks' `session_id`. Every point also
  carries `user.email`, `user.id` and `organization.id` (with account UUIDs switched off), which
  ingest drops.
- **Subagents:** by type only; there is no agent id in any metric or log event (**recorded**).
- **Totals:** metric cost totals equal the per-request `api_request` log costs (**recorded**).
- **Precedence** (**recorded**, with the generic `OTEL_EXPORTER_OTLP_ENDPOINT`; inferred for the
  per-signal variables): the user's settings `env` beats the process env;
  our `--settings` `env` beats the user's settings; the settings file's `env` and the process env
  combine. A user's own OTLP headers were not tested. The docs
  add that managed settings beat everything and repository settings are ignored for these
  variables.
- **Configuration** (ADR 0030, **recorded** as `t-adr`): in the per-session settings `env`,
  `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=none`,
  `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`, `OTEL_METRIC_EXPORT_INTERVAL=5000`,
  `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false`, with the endpoint naming micro-minds' session
  (`/otel/<sessionId>/v1/metrics`); in the PTY env only,
  `OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer <hook token>`. Exports came every 5.0 s.
- **Status line** (**recorded**, not used): session-cumulative `cost.total_cost_usd` with no model
  split, `context_window`, and `rate_limits` (five-hour and seven-day `used_percentage`); it runs on
  UI redraws and its last value missed the final requests.

## Fixtures

Scrubbed recordings live in `fixtures/claude/` (task 1.7, `record-fixture` skill, made by
`npm run spike:scrub`), each listed here with its scenario, CLI version, OS, date and what it shows.
Each line of a hook fixture is one hook payload, in arrival order (HTTP hooks, except in
`qa-command-hook`, the relay); the `otel-*` and `statusline-*` fixtures hold telemetry.
All were recorded with Claude Code 2.1.283 on Windows 11, in `auto` permission mode except
`permission-prompt` (`default`).

| Fixture | Scenario (SCENARIOS.md) | Recorded | Shows |
|---|---|---|---|
| `qa.jsonl` | (a) Q&A | 2026-09-27 | `UserPromptSubmit → Stop → SessionEnd`; no `SessionStart` over HTTP |
| `qa-command-hook.jsonl` | (a) Q&A, relay | 2026-09-27 | The only `SessionStart` payload (`source: "startup"`, `model`), which only a command hook receives |
| `read-edit.jsonl` | (b) read + edit | 2026-09-27 | `Read` then `Edit`, each `PreToolUse`/`PostToolUse` paired by `tool_use_id` |
| `failing-shell.jsonl` | (c) failing shell command | 2026-09-28 | A non-zero exit → `PostToolUseFailure(Bash)` with `error` and `is_interrupt` |
| `failing-shell-masked.jsonl` | (c), first recording | 2026-09-27 | The same failure hidden by `; echo "EXIT: $?"` → `PostToolUse(Bash)` with no exit code |
| `permission-prompt.jsonl` | (d) permission prompt, declined | 2026-09-27 | `PermissionRequest(Write)` with no `tool_use_id`; the decline ends the turn: nothing more until `SessionEnd` |
| `ask-user-question.jsonl` | (e) AskUserQuestion | 2026-09-27 | `PermissionRequest(AskUserQuestion)` as the question dialog, then the answer in `PostToolUse` |
| `subagent.jsonl` | (f) subagent | 2026-09-27 | A background `Explore` subagent: `async_launched`, `SubagentHandback`, an untyped `UserPromptSubmit`, and `SubagentStop`s from agents that never started |
| `ctrl-c.jsonl` | (g) Ctrl-C | 2026-09-27 | `PreToolUse(Bash)`, then nothing until `SessionEnd` from quitting |
| `process-killed.jsonl` | (h) process killed | 2026-09-27 | `PreToolUse(Bash)`, then nothing at all |
| `compaction.jsonl` | (i) compaction | 2026-09-27 | `PreCompact` (`manual`), an unseen agent's `SubagentStop`, and `Notification` (`idle_prompt`) |
| `otel-qa.jsonl` | (a) Q&A, telemetry (`t-qa`) | 2026-09-28 | One OTLP/JSON metrics export per line: delta cost and token points for the main and an auxiliary model |
| `otel-read-edit.jsonl` | (b) read + edit, telemetry (`t-read-edit`) | 2026-09-28 | The same, plus `lines_of_code.count` and `code_edit_tool.decision` |
| `otel-subagent.jsonl` | (f) subagent, telemetry (`t-subagent`) | 2026-09-28 | Subagent points: `query_source: "subagent"`, `agent.name: "Explore"`, no agent id |
| `statusline-qa.jsonl`, `statusline-read-edit.jsonl`, `statusline-subagent.jsonl` | (a), (b), (f), status line | 2026-09-28 | One status-line stdin JSON per line; cumulative `cost.total_cost_usd` |

Replay tests come with the adapter and reducer (tasks 2.1 and 2.4; Phase 2's "Done when" needs
one per fixture) and, for the telemetry fixtures, with usage capture (task 2.14).
