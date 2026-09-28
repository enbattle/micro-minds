# Phase 1 settings checks (task 1.3)

Run 2026-09-27 with Claude Code **2.1.283** on Windows 11, through `npm run spike:drive --
--experiments` (`drive.ts`, the `x-*` scenarios), each in a fresh scratch repo. The captures are in
`~/.micro-minds-dev/spike/captures/x-*.jsonl`, outside the repo. As in `SCENARIOS.md`, nothing here
comes from payload contents: only event names, channels and arrival times.

Docs checked: <https://code.claude.com/docs/en/hooks> (the page's "HTTP response handling" section
was not available, so failure handling was measured instead).

## Results

| Question (PLAN 1.3) | Experiment | Result |
|---|---|---|
| Does `--settings` merge with **project** settings? | `x-merge`: the scratch repo's `.claude/settings.json` sends `UserPromptSubmit` to a `probe` channel; our `--settings` file sends every event to `http`. | **Merges.** `UserPromptSubmit` arrived twice, once per channel. |
| Does it merge with **user** settings? | `x-user-merge` (added 2026-09-28, during task 1.6): the user added a `UserPromptSubmit` hook to the `probe` channel to their own user settings themselves (`npm run spike:drive -- --user-hook` prints it); the driver never reads or writes that file (hard rules 1 and 2). Our `--settings` file sends `UserPromptSubmit` to `http`. Control `x-user-hook-only`: the same session without `--settings`. | **Merges.** `UserPromptSubmit` arrived on both channels, at the same moment; in the control, the user hook alone arrived. A first attempt showed nothing on `probe` in either run: the hook had gone into the wrong file, which the control made visible. (An earlier inference from `auto` mode was dropped: task 1.5's `/config` screen shows "Default permission mode: Manual", so auto mode doesn't come from the user settings file.) **Remove the hook from your user settings afterwards**: it sends `MICROMINDS_HOOK_TOKEN` to the spike port with every prompt, and real micro-minds sessions set that variable. |
| Do HTTP hooks work? | All 1.2 recordings, plus these runs. | **Yes, except `SessionStart`**, which never reached an HTTP hook but did reach a command hook (the relay) in every run (`SCENARIOS.md`, finding 1). |
| Can the header read the token from the environment, so the file holds none? | 1.2 runs (`allowedEnvVars: ["MICROMINDS_HOOK_TOKEN"]`); `x-env-unlisted` (the same header, `allowedEnvVars: []`). | **Yes, only through `allowedEnvVars`.** With it, no request was rejected; without it, all three were rejected (401), so the token never reached the sink. The docs say an unlisted variable becomes an empty string; the sink doesn't log header values, so the run shows the rejection, not the exact header. |
| Can hooks be non-blocking? | Docs; `x-block-base` vs `x-block-slow`: every event through the relay for timing, and `PreToolUse` also to a `probe` that answers at once or after 4 s. | **HTTP hooks block; only command hooks can be async.** The docs give `async` (and `asyncRewake`) to command hooks only. `PreToolUse` → `PostToolUse` took 0.28 s with an immediate reply and 4.16 s with the 4 s reply: the tool waited for the HTTP hook. |
| What happens when an HTTP hook fails? | `x-fail-open`: `PreToolUse` HTTP hooks to a closed port and to a `probe` that answers 500. | **Fails open.** The tool ran and `PostToolUse` followed 0.25 s later, no slower than the baseline. |

## What this means for later tasks

- **Channel (task 1.4):** an HTTP hook adds its own response time to every tool call, up to its
  `timeout`, so the ingest endpoint must answer at once (never after processing), and the timeout
  should be short. A command hook can be `async` and never delay the agent, and it is the only way
  to receive `SessionStart`. Task 1.4 measures the relay's cost to decide.
- **Hook token at rest (threat model, PLAN §5.6):** the per-session settings file can hold
  `Bearer $MICROMINDS_HOOK_TOKEN` with `allowedEnvVars`, never the token. The token lives only in the
  session's environment. Task 2.6 builds this.
- **Hostile repositories (threat model, PLAN §5.2):** a repository's own `.claude/settings.json`
  hooks run in our sessions alongside ours (they merge). Our file doesn't widen that: it holds hooks
  only, no permission allows or permission-skip flags, and lives outside the worktree.
- **The user's own hooks run too:** hooks in the user's settings fire in our sessions alongside
  ours, so a slow or blocking user hook shows up as a slow agent, not as a micro-minds fault.
- **Fail open (hard rule 5, ADR 0009):** confirmed for HTTP hooks on a refused connection and a 500.

## Notes

- In `x-block-base` the session didn't quit on the driver's Ctrl-C and was killed, so its capture
  ends with a `SubagentStop` from an agent that never started (as in `SCENARIOS.md`, finding 6)
  instead of `SessionEnd`. The timing result doesn't depend on the end of the session.
- An early version of `x-merge` also typed `/status` to list the loaded setting sources. That screen
  shows account details as well, so the step was removed rather than filtered.
