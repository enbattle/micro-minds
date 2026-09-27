# Dev harness

How this repo is set up for AI-assisted development with Claude Code. The harness is code: it
is versioned, reviewed and tested like everything else (PLAN §11.1).

## What's in it

| Piece | Location | Purpose |
|---|---|---|
| Root rules | `CLAUDE.md` | Hard rules, conventions and commands, loaded in every session |
| Package rules | `packages/*/CLAUDE.md`, `apps/*/CLAUDE.md` | Rules specific to one package |
| Permissions | `.claude/settings.json` → `permissions` | Allow routine commands without prompts; deny dangerous or sensitive ones |
| Guard hook | `.claude/hooks/guard.ts` (`PreToolUse`) | Second layer for credential and `.env` protection (see below) |
| Format hook | `.claude/hooks/format.ts` (`PostToolUse`) | Runs Biome on every file Claude edits |
| Subagents | `.claude/agents/` | `reviewer` (read-only diff review), `test-writer` |
| Skills | `.claude/skills/` | `phase-status`, `new-adapter`, `record-fixture` |
| Harness evals | `evals/harness/` | Guard tests (run in CI) and reviewer evals (run manually; they spend tokens) |
| Decisions | `docs/decisions/` | ADRs, including the harness policy in ADR 0024 |

`.claude/settings.local.json` is gitignored. Use it for personal overrides and never commit it.

## Credential protection: two layers

CLAUDE.md hard rule 1 says nothing may read `~/.claude`, `~/.gemini`, `~/.codex`, credentials
or `.env` files.

1. **Deny rules** in `.claude/settings.json` block the `Read`/`Edit` tools and the matching
   shell commands.
2. **The guard hook** catches what deny rules miss: forms like `cat "$HOME"/.claude/x`,
   `Get-Content $env:USERPROFILE\.codex\auth.json`, `cat ../../.claude/x`, globs like `~/.c*`,
   recursive searches over the home directory, and commands that dump the whole environment
   (`env`, `printenv`, `Get-ChildItem env:`). It resolves every path-like token against the
   real home directory, so the repo's own `.claude/` is still allowed.

`.env.example`, `.env.sample` and `.env.template` are allowed. Every other `.env` and `.env.*`
file is blocked.

### Exemption: Claude Code's own working files

Claude Code keeps a few of its own working files under `~/.claude`. Blocking them breaks plan
mode, auto-memory and reading large command outputs, so both layers allow exactly these paths
([ADR 0024](decisions/0024-harness-guard-exempts-claude-working-files.md)):

- `~/.claude/plans/**` (plans from plan mode)
- `~/.claude/projects/<slug>/memory/**` (auto-memory)
- `~/.claude/projects/<slug>/tool-results/**` (large tool outputs; read-only in the deny rules)

Everything else stays blocked: `.credentials.json`, `settings.json`, session transcripts, and any
path written with a glob. **This exemption applies to the dev harness only.** App code under
`apps/` and `packages/` must never read these directories.

### Limits

The guard is a heuristic, not a sandbox:

- It can't see paths that a script builds at runtime.
- It may over-block a few rare commands (for example `echo .env >> .gitignore`).
- It doesn't follow a relocated `CLAUDE_CONFIG_DIR`.
- If it gets malformed input, it allows the call (with a note on stderr), so a broken guard
  can never lock Claude Code up.

## Verifying the harness

- `npx vitest run --project harness` runs the deterministic guard and format tests. They also
  run in CI as part of `npm run check`.
- `npm run eval:harness` runs the reviewer evals (spends tokens; see `evals/harness/README.md`).
- To confirm manually, in a Claude Code session in this repo, ask Claude to run
  `cat ~/.claude/settings.json`. It should be blocked with a "micro-minds guard" reason.

## Changing the policy

1. Change `guard.ts` and `settings.json` together, so the two layers agree.
2. Add allow **and** deny cases to `evals/harness/guard/guard.test.ts`.
3. Record the reason in an ADR (a new one, or one that supersedes 0024), and update this page.
4. Re-run the reviewer evals if CLAUDE.md or `.claude/agents/` changed.
