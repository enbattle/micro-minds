# Phase 1 spike: hook capture

Throwaway tooling for the Claude protocol spike ([PLAN §10, Phase 1](../../docs/PLAN.md#phase-1-claude-protocol-spike-throwaway-code-allowed)). It passes `npm run check` but has no tests-first or coverage requirement. Phase 2 reimplements what it needs, and the PR that closes Phase 2 deletes `spikes/`.

| File | What it does |
|---|---|
| `sink.ts` | Loopback HTTP server. `POST /hooks?scenario=<s>&channel=http\|relay` appends the raw payload to `~/.micro-minds-dev/spike/captures/<s>.jsonl`. |
| `relay.ts` | Command-hook path into the sink. Fails open: always exits 0, never writes to stdout, 500 ms POST timeout. |
| `settings.ts` | Writes `~/.micro-minds-dev/spike/settings/<s>.<channel>.json` (hooks only) for `claude --settings`. |
| `relay-selftest.ts` | Checks both channels, the token and Host checks and the fail-open rules against a temporary sink. No `claude` involved. |
| `drive.ts` | `npm run spike:drive [-- <scenario>...]`: records the scenarios as real interactive sessions in node-pty, driven by the hook events the in-process sink receives. Writes each scenario's settings for the port it listens on (`SPIKE_SINK_PORT` or 47110) and gives each scenario a fresh scratch repo under `~/.micro-minds-dev/spike/targets/` (it never runs git in a repo a recorded agent has touched). Spends the user's tokens. |
| `make-target.ts` | `npm run spike:target`: creates the scratch repo `~/micro-minds-spike-target` for recording by hand; `createTarget()` also builds the driver's per-scenario copies. |
| `SCENARIOS.md` | What was recorded, the event sequences, and the findings for task 1.6. |
| `paths.ts` | Shared paths, port and scenario-name rules. |

## Recording a scenario

With the user's OK, `npm run spike:drive` records every scenario (see `SCENARIOS.md`). To record one
by hand instead:

1. **Start the sink** in one terminal: `npm run spike:sink`. It prints a fresh token and the lines to set `MICROMINDS_URL` and `MICROMINDS_HOOK_TOKEN`. The default port is 47110 (`SPIKE_SINK_PORT` overrides it).
2. **Generate settings**: `npm run spike:settings -- <scenario> --channel http` (or `relay`). Scenario names are lowercase letters, digits and dashes, for example `a-qa` or `f-subagent`.
3. **Run Claude** in a second terminal: set the two variables from step 1, change into the scratch repo (for example `~/micro-minds-spike-target`, **never** this repo), and run the `claude --settings "<file>"` command step 2 printed.
4. Each hook event shows up as one line in the sink's console and one line in the capture file.

## Rules

- Raw captures and settings stay under `~/.micro-minds-dev/spike/`. Only scrubbed copies go into `fixtures/claude/` (task 1.7, `record-fixture` skill).
- Never open the file a payload's `transcript_path` points to (hard rule 1).
- Never edit `~/.claude/settings.json` (hard rule 2). Everything goes through `--settings`.
- The user runs every recorded `claude` session. Headless `claude -p` runs need the user's OK, because recordings spend tokens.
- The sink token changes on every start unless `SPIKE_SINK_TOKEN` is set. Files generated with `--literal-token` contain the token and must be regenerated after a restart.
