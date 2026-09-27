# Engineering standards

One checklist of the engineering practices this repo follows, and **what enforces each one**.
Following [the harness principles](dev-harness.md#principles), a practice is enforced by a test,
a CI gate or a tool wherever possible. Prose is the fallback. Practices we chose not to adopt yet
are in [deferred-practices.md](deferred-practices.md).

Status: **Enforced** (a check fails when it's violated) · **Scheduled** (attached to a PLAN task;
the task isn't done until it's in place) · **Convention** (reviewed by the `reviewer` agent and
in PRs, with no automated check).

## Code quality

| Practice | Enforced by | Status |
|---|---|---|
| Strict TypeScript, no `any`, erasable syntax only | `tsc` via `npm run check`; Biome `noExplicitAny`; reviewer `CONV-any`, `CONV-erasable-syntax` | Enforced |
| Lint and format, warnings are errors | Biome `--error-on-warnings` in `npm run check`; format hook on every Claude edit | Enforced |
| Every workspace declares what it imports | Biome `noUndeclaredDependencies` | Enforced |
| `process.env` read only in config modules | Biome `noProcessEnv` with overrides | Enforced |
| Validate every external input with zod | reviewer `CONV-unvalidated-boundary` | Convention |
| Windows is first-class | CI matrix on Windows, macOS and Linux; reviewer `WIN-*` rules | Enforced |

## Testing

| Practice | Enforced by | Status |
|---|---|---|
| Tests first for every code change, fixture-driven where fixtures exist (who writes them and the lock: see the ADR 0028 rows below) | reviewer `TEST-missing`, `TEST-no-fixture`, `TEST-criteria`; `/finish-task` | Convention |
| Coverage thresholds: `packages/shared` 95% lines, functions and statements, 90% branches; `.claude/hooks` 85/80; eval modules 80% lines | `npm run test:coverage` in CI (Ubuntu). Process entry points that only run as subprocesses are marked `v8 ignore`; the eval runner `run.ts` is excluded because it spawns Claude Code | Enforced |
| Coverage thresholds for `apps/server` and `packages/hook-relay` | Added with the first real code in each | Scheduled: 2.6, 2.10 |
| Coverage thresholds for `apps/web` | Added with the web shell | Scheduled: 3.1 |
| Property-based tests for the reducer and scrubber | fast-check suites | Scheduled: 2.1, 2.2 |
| Never call real provider CLIs in tests | reviewer `TEST-real-cli`; fake provider | Convention |
| Deterministic tests (no wall clock or randomness in shared) | reviewer `TEST-nondeterministic`, `HR9-impure-reducer` | Convention |
| End-to-end smoke tests with the fake provider | Playwright | Scheduled: 3.9 |
| Accessibility: keyboard, ARIA, no color-only state, reduced motion | axe-core in Playwright; task checklist | Scheduled: 3.11, 4a.2 |
| Performance budgets: bundle size, 60 fps scene, reducer throughput | CI bundle check; demo-mode perf pass; benchmark | Scheduled: 3.1, 4a.7 |

## Data and interfaces

| Practice | Enforced by | Status |
|---|---|---|
| Versioned event schema and WS protocol | Tests in 2.1 and 2.8 | Scheduled: 2.1, 2.8 |
| Versioned, forward-only DB migrations, each tested | Migration tests | Scheduled: 2.7 |
| Structured logging with redaction, `sessionId` on every line | Logging conventions set in 2.6; reviewer `HR8-*`, `SEC-token-exposure` | Scheduled: 2.6 |
| IDs are ULIDs; timestamps are server-stamped ms epoch | reviewer `CONV-ids-timestamps` | Convention |

## Security

| Practice | Enforced by | Status |
|---|---|---|
| Threat model kept current | [security/threat-model.md](security/threat-model.md); reviewed at each phase gate and in PRs touching listed components | Convention |
| Vulnerability reporting policy | [SECURITY.md](../SECURITY.md) | Enforced (published) |
| Secrets never committed | GitHub secret scanning with push protection | Enforced |
| Static analysis | CodeQL (default setup); the `ci-verify` ruleset blocks high-severity alerts | Enforced |
| Dependency vulnerabilities | Dependabot alerts and security updates; `npm audit` in CI: runtime dependencies fail at high severity, all dependencies fail at critical | Enforced |
| Supply chain: pinned actions, lockfile, cooldown | Actions pinned to SHAs; `npm ci`; Dependabot 7-day cooldown | Enforced |
| `@types/node` tracks the runtime Node major | Dependabot ignores semver-major updates for it (ADR 0023) | Enforced |
| Localhost binding, token scoping, origin checks, redaction | CLAUDE.md hard rules; security tests | Scheduled: 2.9 |
| Agent terminal output is untrusted (OSC 52, OSC 8) | reviewer `SEC-terminal-escape` | Scheduled: 3.3 |

## Process

| Practice | Enforced by | Status |
|---|---|---|
| Changes land through PRs with green CI | `protect-main` and `ci-verify` rulesets (3 OS checks, CodeQL) | Enforced |
| Conventional commits and PR titles | `commits` CI job (`scripts/lint-commits.ts`); `npm run lint:commits` locally | Enforced |
| Merge commits, not squash, so per-task history survives | Repo settings: squash disabled | Enforced |
| Per task: a locked test commit (code tasks), then one implementation commit, an independent review, the checkbox ticked; one PR per task or per phase | CLAUDE.md "Before finishing"; `/finish-task`, `/run-phase` | Convention |
| Claude pushes task and phase branches but never merges; the user's merge is the human review | `.claude/settings.json` allow and deny rules, checked against a command table in `evals/harness/integrity/` (CI); `protect-main` and `ci-verify` rulesets (ADR 0027) | Enforced |
| Decisions recorded as ADRs | `docs/decisions/`; reviewer `ARCH-missing-adr` | Convention |
| Docs stay accurate: no broken links, small always-loaded context | `evals/harness/docs/docs.test.ts` (CI) | Enforced |

## AI developer harness

| Practice | Enforced by | Status |
|---|---|---|
| Harness changes follow the harness principles | [dev-harness.md](dev-harness.md#principles); PR review | Convention |
| Guard hook behavior | 215+ deterministic guard tests in CI | Enforced |
| The harness is internally consistent: hooks exist and are registered and tested, matchers use real tool names, the guard and settings agree on exemptions, agent and skill frontmatter is valid, hard-rule numbering matches the reviewer catalog | `evals/harness/integrity/` (CI) | Enforced |
| Sessions start with live context (branch, next task, eval rules due, dirty tree) rather than a longer CLAUDE.md | `SessionStart` hook `session-context.ts`, tested in `evals/harness/session/` | Enforced |
| Tests for a code task are written first by a separate, fresh `test-writer`, from the task text only, then locked; the implementer never edits them | `/start-task` step 6; `scripts/tests-locked.ts` (`npm run tests:locked`), its planted-violation tests in CI; `/finish-task` step 1; reviewer `TEST-lock` (ADR 0028) | Enforced |
| Review is independent and adversarial: artifact-only input, re-runs the checks, probes failure cases, shows what it probed, never changes the repository; a security pass where due | `reviewer` agent; `/finish-task` step 4 (fixed prompt, before/after snapshot); eval parser rejects an empty `probed` (ADR 0028) | Enforced (probed, snapshot); convention (prompt content) |
| A phase run ends with a completeness audit of every task and "Done when" clause | `/run-phase` step 3 | Convention |
| The task workflow is a procedure, not prose | `/start-task` (plan before code; Edit and Write disabled until you approve), `/finish-task` (ordered gates) and `/run-phase` (a whole phase, stopping for human steps) | Convention: skills, evals scheduled in 2.15 |
| Every reviewer rule has an eval case, or one is scheduled | `coverage.test.ts` reads PLAN checkboxes (CI) | Enforced |
| Reviewer quality does not regress | `npm run eval:harness -- --trials 3` at every phase gate; baseline history | Enforced at phase gates |
| Evals for `test-writer`, skills, golden task, red-team prompts | PLAN tasks | Scheduled: 2.15, 2.16 |

## Changing this page

Add a row in the same PR that introduces a practice, and link the check that enforces it. When a
scheduled practice lands, change its status to Enforced. When we decide against a practice, move
it to [deferred-practices.md](deferred-practices.md) instead of deleting it.
