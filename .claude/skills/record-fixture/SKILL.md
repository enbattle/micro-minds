---
name: record-fixture
description: Scrub-and-commit workflow for a micro-minds hook fixture - place a captured provider hook payload stream in fixtures/<provider>/<scenario>.jsonl, scrub paths, usernames, emails, hostnames, tokens and session ids, prove no secrets remain, add a replay test, and record the CLI version in docs/protocols/<provider>.md. Use when adding or re-recording a fixture, when scrubbing captured payloads (PLAN task 1.7), or when a bug fix needs a reproducing fixture. Takes provider and scenario as arguments.
argument-hint: <provider> <scenario>
arguments: [provider, scenario]
allowed-tools: Read Grep Glob Bash(node -e *) Bash(git status *) Bash(git diff *)
---

# Record a fixture: `$provider` / `$scenario`

Fixtures are the test backbone (PLAN §11): recorded, scrubbed hook payloads that the adapter and reducer tests replay. A fixture that leaks a path, name or secret is a security bug in a public repo. Follow every step in order and don't skip the verification in step 4.

If `$provider` or `$scenario` is missing, ask for them. `$provider` is one of `claude`, `fake`, `gemini` or `codex`. `$scenario` is kebab-case and describes behavior, not the date: `qa`, `read-edit`, `failing-shell`, `permission-prompt`, `ask-user-question`, `subagent`, `ctrl-c`, `process-killed`, `compaction`, or `bug-<short-name>` for a regression.

## Never

- Never read, list, copy or grep anything under `~/.claude`, `~/.gemini`, `~/.codex`, and never open a `transcript_path` a payload points to. Payloads come **only** from the hook capture sink (PLAN task 1.1). If a payload lacks something, re-record; don't look it up in provider files.
- Never read `.env*` or credential files to "check" what to scrub.
- Never `git add` or commit a fixture before step 4 passes. Prefer capturing outside the repo (for example under `~/.micro-minds-dev/captures/`) and writing only the scrubbed result into `fixtures/`.

## 1. Place the file

- Path: `fixtures/$provider/$scenario.jsonl`. Re-recording replaces the whole file; don't append to an old recording.
- Format: **JSONL, exactly one hook payload per line**, in the order received, as the provider sent it (the parsed JSON body, not our normalized `AgentEvent`). UTF-8, LF line endings, no trailing blank line, no comments, no pretty-printing. Each line must be valid JSON on its own.
- Keep the provider's field names and structure untouched. Scrubbing changes **values** only, so the fixture still exercises the real parser.

## 2. Scrub

Replace values consistently across the whole file: the same real value always maps to the same placeholder, so relationships (same session, same parent agent, same path) survive.

| What | Replace with |
|---|---|
| Home dir on POSIX (`/home/<name>`, `/Users/<name>`) | `/home/user` |
| Home dir on Windows (`C:\Users\<name>`, in JSON `C:\\Users\\<name>`) | `C:\\Users\\user` (as escaped in JSON) |
| Repo checkout path | `<home>/projects/sample-repo` |
| Worktree path | `<home>/.micro-minds/worktrees/sample-repo/01J0000000000000000000000S` |
| `transcript_path` | `<home>/.claude/projects/sample-repo/00000000-0000-4000-8000-000000000001.jsonl` (a placeholder only; never read) |
| OS username anywhere else (prompts, git output, `whoami`) | `user` |
| Hostname / machine name | `host` |
| Emails (git author, output) | `user@example.com` |
| Provider session ids and agent ids (UUIDs, hex ids) | Sequential per distinct value: `00000000-0000-4000-8000-000000000001`, `…002`, … keeping the original shape (a UUID stays a UUID) |
| `tool_use_id`s | Keep the provider prefix, sequential suffix: `toolu_000001`, `toolu_000002`, … |
| API keys, bearer tokens, OAuth tokens, JWTs, `MICROMINDS_HOOK_TOKEN` or any `*_TOKEN`/`*_KEY`/`*_SECRET`/`PASSWORD` value | `<redacted>` |
| File contents in `tool_response` / `tool_input.content` | Keep only what the test needs (for example the first line), and replace anything env-like or personal with `<redacted>` |
| Timestamps | Keep them if tests depend on ordering; otherwise shift to a fixed base (`2026-01-01T00:00:00.000Z`) keeping deltas |

Find the real values to replace (your username, hostname and home dir) without reading any provider files:

```
node -e "const o=require('node:os');console.log(JSON.stringify({user:o.userInfo().username,host:o.hostname(),home:o.homedir()}))"
```

## 3. Validate the structure

- Every line parses: `node -e "const f=require('node:fs');f.readFileSync(process.argv[1],'utf8').trimEnd().split('\n').forEach((l,i)=>{try{JSON.parse(l)}catch(e){console.error('line',i+1,e.message);process.exitCode=1}})" fixtures/$provider/$scenario.jsonl`
- The file contains the events the scenario claims (for example `permission-prompt` includes the permission event). Compare against `docs/protocols/$provider.md`.

## 4. Prove nothing sensitive remains

Run each check with the **Grep tool** (ripgrep, so it behaves the same on Windows, macOS and Linux) on `fixtures/$provider/$scenario.jsonl`. Group 4 must return zero matches; every match of the other groups must be a step 2 placeholder. Investigate each hit and re-scrub; don't whitelist a hit you don't understand.

Ripgrep's default engine has no lookahead, so the "inspect" patterns match broadly: every match must be one of the step 2 placeholders. One pattern per line (`#` lines are labels, not patterns). Use `-i: true` for the first group.

```
# 1. Your literal username, hostname and home dir (from the node -e command above), case-insensitive
<username>
<hostname>

# 2. Home directories: every match must be /home/user, /Users/user or C:\\Users\\user
/(home|Users)/[^/"\\]+
[A-Za-z]:\\\\+Users\\\\+[^\\"]+

# 3. Emails: only user@example.com is allowed
[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}

# 4. Keys and tokens: must return zero matches
sk-(ant-)?[A-Za-z0-9_-]{16,}
gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}
AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]+
-----BEGIN [A-Z ]*PRIVATE KEY-----
(?i)bearer\s+[A-Za-z0-9._~+/-]{12,}
eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.

# 5. Secret-looking assignments: every value must be <redacted>
(?i)(api[_-]?key|secret|token|passw(or)?d)[^:=]{0,20}[:=]\s*\\?"?[^\s",\\]{6,}

# 6. Session/agent ids: every match must start with 00000000-0000-4000-8000-
[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}

# 7. Long high-entropy strings: inspect each; allow only hashes the test needs
[A-Za-z0-9+/_-]{40,}
```

Then run `git status --short` and `git diff --stat` to confirm the only new or changed files are the fixture, its test and the protocol doc.

## 5. Add a replay test

- Adapter: add the fixture to the adapter's table-driven replay test in `apps/server/src/providers/$provider/` (one row: file name → expected `kind` sequence and tool categories). Unknown events in the fixture must come out as `kind: 'unknown'`.
- Reducer: add it to the shared fixture-replay snapshot test, so the final `WorldState` and per-agent activity sequence are snapshotted. Time advances only through `clock.tick` events inserted by the test (D15).
- A `bug-*` fixture gets a test that fails before the fix. Name the test after the bug.
- Use the `test-writer` agent if the test is more than one table row. Run only the affected test file: `npx vitest run <file>`.

## 6. Record provenance

In `docs/protocols/$provider.md`, add or update the row for this fixture in the fixture table: scenario, file, **CLI version** (`<cli> --version` output, run by the user or the capture tooling, not read from config), OS, date recorded, and one line on what it demonstrates. If the recording shows a fact that contradicts the protocol doc or PLAN §5.3, update the doc and flag it: it may need an ADR.

## 7. Done when

- The fixture parses line by line, every check in step 4 is empty, the replay test runs, and the protocol doc names the CLI version.
- The commit contains only the fixture, its test(s) and the doc, and uses a conventional message, for example `test(claude): add permission-prompt fixture (1.2)`.
