# 0024. The dev-harness guard exempts Claude Code's own working files

- Status: Accepted
- Date: 2026-09-26
- Plan: D24 (PLAN §2)

## Context

CLAUDE.md hard rule 1 forbids reading `~/.claude`, `~/.gemini` and `~/.codex`. The dev harness
enforces it for Claude Code sessions working *on this repo* in two layers:
`.claude/settings.json` deny rules, and the `PreToolUse` guard `.claude/hooks/guard.ts` (task 0.6).

Claude Code also stores some of its own working files under `~/.claude` and reads them back
with its normal file tools:

- `~/.claude/plans/`: plans written in plan mode.
- `~/.claude/projects/<slug>/memory/`: per-project auto-memory.
- `~/.claude/projects/<slug>/tool-results/`: large tool outputs, saved to disk and read back.

A blanket block broke plan mode, auto-memory and reading large command outputs while working
in this repo. None of these directories hold credentials or CLI configuration, and that is what
the rule protects.

## Decision

The dev harness allows exactly these subtrees of `~/.claude`:

| Path | Read | Edit/Write |
|---|---|---|
| `~/.claude/plans/**` | allowed | allowed |
| `~/.claude/projects/<slug>/memory/**` | allowed | allowed |
| `~/.claude/projects/<slug>/tool-results/**` | allowed | blocked by the deny rule and by the guard (aligned 2026-09-27, found by the harness integrity test) |

Everything else in `~/.claude` stays blocked, notably `.credentials.json`, `settings.json`,
session transcripts (`projects/<slug>/*.jsonl`) and listings of `projects/`. `~/.gemini` and
`~/.codex` get no exemptions.

- The guard only applies an exemption when **every path segment is literal**. A glob such as
  `~/.claude/projects/*/memory` or `~/.claude/pl*` is denied, because globs could widen the
  match to credentials or transcripts.
- The settings file carves the same paths out of its deny rules with `!` patterns.
- Tests in `evals/harness/guard/guard.test.ts` cover the allowed paths and the near misses.

**This is a dev-harness policy only.** The micro-minds application itself (`apps/`, `packages/`)
must never read anything under these directories. Hard rule 1 is unchanged for app code.

## Consequences

### Positive

- Plan mode, auto-memory and large-output reads work in this repo.
- The exemption is narrow and testable. Credentials and settings stay protected by both layers.

### Negative

- More surface to reason about. Memory and plan files could in theory contain something
  sensitive the user typed. Accepted, since Claude Code wrote them for its own use.
- If Claude Code moves these directories or adds new working areas, the exemption goes stale
  and the feature breaks again (fails closed, which is the safe direction).
- `CLAUDE_CONFIG_DIR` relocation isn't followed by the guard.

## Revisit when

A Claude Code release changes where plans, memory or tool results are stored, or a new
Claude Code feature needs another working directory under `~/.claude`.

## References

- CLAUDE.md hard rule 1
- `docs/dev-harness.md`
- ADR 0004 (the app never touches credentials)
- `.claude/hooks/guard.ts` (`isClaudeWorkingFile`), `.claude/settings.json`
