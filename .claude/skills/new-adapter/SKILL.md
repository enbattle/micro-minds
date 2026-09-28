---
name: new-adapter
description: Audit or plan a micro-minds provider adapter (claude, fake, gemini, codex) against the adapter checklist - protocol doc with CLI version, scrubbed fixtures, per-session hook injection, tool-name to ToolCategory map, facts-only normalize, unknown events, errorClass, resumeId, registry entry with Windows binary resolution, conformance suite, telemetry verdict, ADRs. Use when starting, reviewing or finishing work on apps/server/src/providers/<name>/, or when asked "is the <provider> adapter done". Takes the provider name as its argument.
argument-hint: <provider>
arguments: [provider]
allowed-tools: Read Grep Glob Bash(git log *)
---

# Adapter checklist for `$provider`

You audit the repo and report the status of every checklist item for the provider **`$provider`**. This skill is an audit: it doesn't write code. After the report, offer to start on the first unmet item within the current PLAN task only.

If `$provider` is empty, or isn't one of `claude`, `fake`, `gemini` or `codex` (PLAN §4.1 `Provider`), stop and ask which provider. Adding a new provider name is a change to `packages/shared` and needs its own task.

**Hard limits while checking:** never read or list anything under `~/.claude`, `~/.gemini`, `~/.codex`, and never run the provider CLI. Evidence comes only from the repo.

## Where things live

- Protocol facts: `docs/protocols/$provider.md`
- Fixtures: `fixtures/$provider/*.jsonl`
- Adapter: `apps/server/src/providers/$provider/`
- Registry: `apps/server/src/providers/registry.ts` (or wherever `ProviderRegistry` is defined; Grep for it)
- Conformance suite: Grep for `conformance` under `apps/server/src/providers/`
- Shared contract: `packages/shared/src/` (`ToolCategory`, `EventKind`, `AgentEvent` schema)
- ADRs: `docs/decisions/*.md`

## Checklist

Check each item with Read, Grep and Glob. Status is one of **done**, **partial**, **missing**, or **n/a** (with a reason, for example the fake provider has no real CLI version). Every status cites evidence: a file path and line, or the Glob or Grep that came back empty.

1. **Protocol doc.** `docs/protocols/$provider.md` exists, names the **CLI version** tested, and lists the verified hook/event names with their payload fields. Every "verify" for this provider in PLAN §5 is closed there or turned into an ADR.
2. **Fixtures recorded and scrubbed.** At least one `fixtures/$provider/<scenario>.jsonl` per PLAN task 1.2 scenario that the provider supports (Q&A, read+edit, failing shell, permission, question, subagent, Ctrl-C, kill, compaction). Spot-check the scrub with the patterns in the `record-fixture` skill (home paths, usernames, emails, tokens, unnormalized session ids). Any hit is **partial**.
3. **Injection mechanism verified, never global config.** The adapter injects hooks per session (Claude: a settings file under `<MICROMINDS_HOME>/sessions/<id>/` passed with `--settings`), and the protocol doc records that the mechanism was verified to merge with user and project settings. Grep the adapter for `.claude`, `.gemini`, `.codex`, `homedir` and `settings.json`. Any write outside `<MICROMINDS_HOME>`, or into the worktree without `.git/info/exclude`, is **missing** (hard rules 1–2).
4. **Tool-name → ToolCategory map.** One exported `as const` map covering every tool name seen in the fixtures and the protocol doc, mapping to `read | write | exec | delegate | ask | web | other`. Unknown tool names fall back to `'other'`. Delegation tools (`Task`/`Agent` for Claude) are `delegate`; question tools (`AskUserQuestion`) produce `attention.question`.
5. **Facts-only normalize.** `normalize(raw: unknown)` parses with zod and sets only `kind`, `tool`, `text`, `errorClass`, `agentId`/`parentAgentId` and a bounded, scrubbed `raw`. Grep the adapter for `health`, `severity`, `mood` and `healthReason`: any assignment is **missing** (hard rule 6). `ts` and `id` are stamped by the server, not the adapter.
6. **Unknown → `kind: 'unknown'`.** Unrecognized or malformed payloads return `kind: 'unknown'` with `raw` kept and never throw (hard rule 7). There's a test feeding garbage, an unknown event name and a missing field.
7. **errorClass mapping.** Turn failures map to `rate_limit | auth | budget | other` from payload facts named in the protocol doc, with a fixture or table test per class.
8. **resumeId capture.** The provider's resumable session id is captured from a hook payload (Claude: `session_id` on the first hook payload that carries one, since `SessionStart` never reaches an HTTP hook (D29); never from `~/.claude`), and the registry knows the resume argv (D20). If the provider can't resume, record **n/a** with the protocol-doc reference.
9. **Registry entry with Windows binary resolution.** The provider is registered with binary name, version probe (`--version`), injection strategy, tool map and resume argv. Resolution handles `.cmd`/`.exe` on Windows via PATH/PATHEXT lookup, with no `shell: true` on user input and no string path concatenation.
10. **Conformance suite passing.** The adapter is included in the shared conformance suite, and every fixture has a replay test (the reducer replay snapshot in `packages/shared` or an adapter test). Say which command runs it (`npm test -w @micro-minds/server`). Don't run it unless asked; report "not run" otherwise.
11. **Telemetry verdict.** The protocol doc and the registry state `telemetry: 'full'` (hooks cover PLAN §5.3) or `'limited'` (terminal-only fallback, §5.4), with the reason. A limited verdict needs the UI badge path to exist.
12. **ADR for deviations.** Anything that departs from PLAN §2 or §5 (for example no native HTTP hooks, so the relay is used; a worktree file; limited telemetry) has an ADR in `docs/decisions/`. Grep ADR titles and bodies for `$provider`.

## Output format

```
## Adapter checklist: $provider

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Protocol doc (CLI version) | done | docs/protocols/$provider.md:3 "Tested with 2.1.283" |
| 2 | Fixtures recorded + scrubbed | partial | 6/9 scenarios; fixtures/$provider/permission.jsonl:4 has C:\Users\<real name> |
…

**Verdict:** ready / not ready (N items missing, M partial)
**Next step:** <the first missing item, phrased as a PLAN-task-sized action>
```

Report only what you verified. If you couldn't determine something, say so.
