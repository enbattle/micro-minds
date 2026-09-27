# Dev harness

How this repo is set up for AI-assisted development with Claude Code. The harness is code: it
is versioned, reviewed and tested like everything else (PLAN §11.1).

## Principles

Every change to the harness is judged against these, in order:

1. **Procedures and checks beat prose.** When a rule matters, turn it into something that runs:
   a skill that performs the steps, a hook, or a deterministic test or CI gate. A written
   instruction is the fallback, not the goal. For example, the eval-coverage schedule is
   enforced by a test that reads PLAN.md checkboxes, not by a reminder.
2. **Add agents, skills and hooks only when evidence shows a need.** Evidence means an eval
   result, a real miss, or repeated friction. A new specialized agent needs an eval showing that
   the existing one falls short.
3. **Prefer deterministic over model-judged.** Anything that can be checked without a model (the
   guard, file layout, frontmatter, links, coverage) is checked in CI for free. Model-judged
   evals are reserved for what only a model can judge, and they run with multiple trials.
4. **Fail safe, never brick.** Safety layers deny by default where secrets are involved, but a
   broken harness component must never lock up the agent (the guard allows malformed input and
   logs it).
5. **Keep always-loaded context small.** CLAUDE.md holds rules and pointers. Details live in
   linked docs, and dynamic state (current task, overdue evals) is computed, not written down.
6. **Record what we decide not to do.** Rejected and deferred practices go in
   [deferred-practices.md](deferred-practices.md) with the trigger that would bring them back,
   so a future session can find them instead of re-debating them.

## What's in it

| Piece | Location | Purpose |
|---|---|---|
| Root rules | `CLAUDE.md` | Hard rules, conventions and commands, loaded in every session |
| Package rules | `packages/*/CLAUDE.md`, `apps/*/CLAUDE.md` | Rules specific to one package |
| Permissions | `.claude/settings.json` → `permissions` | Allow routine commands without prompts, including pushes to task and phase branches and opening PRs; deny dangerous or sensitive ones, force-pushes, pushes to `main` and merges (ADR 0027) |
| Guard hook | `.claude/hooks/guard.ts` (`PreToolUse`) | Second layer for credential and `.env` protection (see below) |
| Format hook | `.claude/hooks/format.ts` (`PostToolUse`) | Runs Biome on every file Claude edits |
| Session context hook | `.claude/hooks/session-context.ts` (`SessionStart`) | Injects live state (branch, next task, eval rules due with it, dirty tree) so CLAUDE.md stays small |
| Subagents | `.claude/agents/` | `reviewer` (read-only diff review; pass it the `git diff` output, since it has no shell), `test-writer` |
| Workflow skills | `.claude/skills/start-task`, `finish-task`, `run-phase` | Turn CLAUDE.md's task workflow into procedures: scope and plan a task; check, review, tick, commit, push and open the PR; or run a whole phase as one PR. You merge |
| Other skills | `.claude/skills/` | `phase-status`, `new-adapter`, `record-fixture` |
| Harness evals | `evals/harness/` | Deterministic, in CI: guard, coverage schedule, session context, harness integrity, doc links and budgets. Manual (they spend tokens): reviewer evals |
| Reference docs | `docs/glossary.md`, `docs/architecture.md` | Precise terms, and a map of the code as it exists |
| Decisions | `docs/decisions/` | ADRs, including the harness policy in ADR 0024 |

`.claude/settings.local.json` is gitignored. Use it for personal overrides and never commit it.

## Task workflow

1. `/phase-status` (optional) shows where the plan stands and what's next.
2. `/start-task <id>` validates the task, sets up a branch, lists everything due with it
   (acceptance criteria, eval cases, scheduled standards), and plans before any code.
3. Implement, tests first where CLAUDE.md requires it.
4. `/finish-task` runs the gates in order (check, coverage, eval schedule, reviewer), ticks the
   checkbox, updates docs, commits, pushes the branch, opens the PR and waits for CI. It never
   merges: it ends with the merge command for you (ADR 0027). It reviews **what is staged**, so the
   check, the reviewer and the commit all see the same bytes. It's user-invoked only, because it
   commits and pushes.

**Whole phases:** `/run-phase <n>` repeats steps 2–4 for every remaining task of a phase on one
branch, `phase/<n>-<slug>`, with one commit per task and one draft PR that CI checks on every
push. Starting it approves that phase's per-task plans, commits, pushes and eval runs. It stops
for steps only you can do or decide (for example Phase 1's recordings, or an ambiguous PLAN
task), and at the end it runs the phase gate, marks the PR ready and hands you the merge. Run it
again to resume after a stop.

**Which to use:** until the MVP ships (Phase 4a), `/run-phase` is the default: the aim is a usable
app soon, and a phase run cuts the human round-trips without dropping any gate. After that,
per-task PRs are the default again, because changes then land in an app people use (ADR 0027).

Claude can't change its own permissions: changes to `.claude/settings.json` are yours to apply.

Flags: `/start-task <id> --branch` creates the proposed branch without asking.
`/finish-task --run-evals` allows the token-spending eval runs; without it the skill asks first.
`/run-phase` always runs them (starting it is the approval).

## Where knowledge goes (memory policy)

Claude Code has an auto-memory under `~/.claude/projects/<slug>/memory/` (exempt from the guard,
ADR 0024). It's personal: it lives on one machine and nobody reviews it. So:

| Knowledge | Goes in |
|---|---|
| Facts about the repo, its design or its tools (how X works, why Y was chosen) | The repo: PLAN, an ADR, `docs/*`, a protocol doc, or a package CLAUDE.md, in a reviewed PR |
| Rules every session must follow | CLAUDE.md, within its size budget; details in linked docs |
| Practices we chose not to adopt | [deferred-practices.md](deferred-practices.md) |
| Personal preferences (tone, how much detail you like, your usual workflow) | Auto-memory |
| Progress on the current task | The PR, commits, and the PLAN checkbox. Not memory |

If a memory turns out to describe the repo, move it into the docs and delete the memory. Claude
should never treat a memory as more authoritative than the repo files it describes.

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
- `~/.claude/projects/<slug>/tool-results/**` (large tool outputs; read-only: Edit and Write are blocked by both layers)

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
