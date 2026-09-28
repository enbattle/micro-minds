# Phase 1 recordings (task 1.2)

Recorded 2026-09-27 with Claude Code **2.1.283** on Windows 11, in scratch repositories with the
content of `make-target.ts` (the first, `~/micro-minds-spike-target`, by a standalone copy of it). Raw captures are in `~/.micro-minds-dev/spike/captures/<scenario>.jsonl`,
outside the repo; task 1.7 scrubs them into `fixtures/claude/`. Nothing below comes from payload
contents: only hook event names, tool names and order.

## How they were recorded

`npm run spike:drive` (`drive.ts`) runs each scenario as a real interactive session: `claude
--settings <scenario file>` in a pseudo-terminal (node-pty, ConPTY), with the sink in-process. It
drives the session from the hook events the sink receives, not from screen timing. The final
driver never approves a permission prompt: it declines with Esc in (d), ends the session on any
other `PermissionRequest`, picks option A in (e) only while the question's own menu is on screen,
presses Enter only when no permission dialog is showing, and quits with Ctrl-C. Earlier versions
answered prompts more loosely (see the table below), but no kept capture outside (d) and (e)
contains a `PermissionRequest`, so nothing was approved in the recordings kept. The only screen it answers is the folder-trust dialog for the scratch repository.
The user approved this in place of recording by hand (PLAN Phase 1, "Before you start").

Every scenario used the user's own Claude Code settings, which start in **auto mode**, except (d),
which ran with `--permission-mode default` so that the permission prompt actually appears.

Which version of `drive.ts` made each capture (the changes affect how sessions are run, not which
events arrive):

| Captures | Driver version |
|---|---|
| (b), (d), (f), (g), (h), (i), and the relay runs of (a) and (b) | Earlier versions: pre-generated settings files with the same content, one shared scratch repo (`~/micro-minds-spike-target`) reset with git between scenarios |
| (a) | An intermediate version: wrote its own settings, still the shared scratch repo |
| (e), and (c) re-recorded in task 1.7 | The final version: its own settings, a fresh scratch repo under `~/.micro-minds-dev/spike/targets/`, and no permission prompt ever approved |

An extra, aborted run of (e) with `--allowedTools AskUserQuestion` is kept as
`e-ask-question-allowed.jsonl`: it shows `PermissionRequest(AskUserQuestion)` still firing (finding 5).

## Event sequences

| Scenario | Channel | Events (in arrival order) |
|---|---|---|
| (a) Q&A | http | UserPromptSubmit → Stop → SessionEnd |
| (a) Q&A | relay | SessionStart → UserPromptSubmit → Stop → SessionEnd |
| (b) read + edit | http | UserPromptSubmit → PreToolUse(Read) → PostToolUse(Read) → PreToolUse(Edit) → PostToolUse(Edit) → Stop → SessionEnd |
| (b) read + edit | relay | SessionStart → the same as http |
| (c) failing shell command | http | UserPromptSubmit → PreToolUse(Bash) → PostToolUseFailure(Bash) → Stop → SessionEnd (re-recorded; see finding 3) |
| (d) permission prompt, declined | http | UserPromptSubmit → PreToolUse(Write) → PermissionRequest(Write) → SessionEnd |
| (e) AskUserQuestion | http | UserPromptSubmit → PreToolUse(AskUserQuestion) → PermissionRequest(AskUserQuestion) → PostToolUse(AskUserQuestion) → Stop → SessionEnd |
| (f) subagent | http | UserPromptSubmit → PreToolUse(Agent) → SubagentStart (Explore) → PostToolUse(Agent) → Stop → (subagent) PreToolUse(Bash) → SubagentStop* → PostToolUse(Bash) → PreToolUse(Bash) → SubagentStop* → PostToolUse(Bash) → PreToolUse(SubagentHandback) → PostToolUse(SubagentHandback) → UserPromptSubmit → SubagentStop (Explore) → Stop → UserPromptSubmit → SubagentStop* → Stop → SessionEnd. *From an agent id that never sent `SubagentStart` (empty `agent_type`), not the Explore subagent: see finding 6. |
| (g) Ctrl-C | http | UserPromptSubmit → PreToolUse(Bash) → SessionEnd |
| (h) process killed | http | UserPromptSubmit → PreToolUse(Bash) (nothing after the kill) |
| (i) compaction | http | UserPromptSubmit → PreToolUse(Read) → PostToolUse(Read) → PreToolUse(Read) → PostToolUse(Read) → Stop → UserPromptSubmit → Stop → PreCompact → SubagentStop → Notification → SessionEnd |

## Findings (confirmed in `docs/protocols/claude.md`, task 1.6)

1. **`SessionStart` doesn't reach an HTTP hook.** It arrived in both relay runs (command hook) and in
   none of the nine HTTP runs, including after `/compact`. PLAN §5.3 maps it to `session.started`,
   so the channel choice (task 1.4) must account for it: a command hook for `SessionStart`, or
   start derived from the PTY.
2. **The HTTP hook header reads the token from the environment** (`allowedEnvVars`): no request was
   rejected. Part of task 1.3.
3. **A shell command that exits non-zero is a tool failure: `PostToolUseFailure(Bash)`**, with an
   `error` string, `is_interrupt: false` and `duration_ms` (no `tool_response`). Corrected during
   task 1.7: the first recording of (c) gave `PostToolUse(Bash)`, but its agent had run
   `node scripts/fail.js; echo "EXIT: $?"`, so the command as a whole exited 0. The re-recording
   (2026-09-28, the final driver) asks for the exact command and gets the failure (`Exit code 3`; an
   attempt before it, where `node` wasn't found in the agent's shell, exited 127 and also gave
   `PostToolUseFailure`). A wrapper like
   that hides a failure from the hooks, so `tool.failed` sees only commands whose own exit is
   non-zero.
4. **Declining a permission prompt (Esc) cancels the turn:** no `PostToolUse`, no `Stop`.
5. **`AskUserQuestion`'s question dialog is itself a `PermissionRequest(AskUserQuestion)`.** It fired
   when the question's menu appeared ("Enter to select · ↑/↓ to navigate"), and still fired with
   `--allowedTools AskUserQuestion`; there was no separate approval prompt. §5.3 maps the tool to
   `attention.question`, so `PermissionRequest` for this tool must also mean `attention.question`,
   never `attention.permission`.
6. **Subagents can run in the background.** `PostToolUse(Agent)` and the main `Stop` came before the
   subagent finished; its result came back as `PreToolUse/PostToolUse(SubagentHandback)` and then a
   `UserPromptSubmit` that no user typed. Of the four `SubagentStop` events, only one is the
   Explore subagent's. The other three come from three different agent ids, each with an empty
   `agent_type` and no `SubagentStart`: one during each of the subagent's two Bash calls, and one
   after the last prompt. The Explore subagent's own `SubagentStop` came after its handback's
   `UserPromptSubmit`. So a `SubagentStop` can arrive for an agent the app never saw start, and
   must not create or end a visible subagent on its own. The subagent's own tool events carry its
   `agent_id` and `agent_type`, so tool activity can be attributed to the right subagent.
7. **An interrupt (Ctrl-C) after `PreToolUse` sends nothing:** no `PostToolUse`, no `Stop`. (It came
   1.5 s after `PreToolUse(Bash)`; in auto mode that may still have been the approval step rather
   than the command running, which the recording can't tell apart.) The `SessionEnd`
   in (g) came about 5 s later, from the double Ctrl-C that quit the session. A killed process sends
   nothing more either: the app must detect both from PTY state and the process exit (§5.4).
8. **Compaction** (`/compact`) sent `PreCompact` (trigger `manual`), then a `SubagentStop` about
   9 s later, from an agent id that never sent `SubagentStart` (empty `agent_type`), as in finding 6; no `SessionStart` followed it over HTTP (see 1). The `Notification` after it is the
   idle-input notice (`idle_prompt`), sent 60 s after the session went idle, not part of compaction.
