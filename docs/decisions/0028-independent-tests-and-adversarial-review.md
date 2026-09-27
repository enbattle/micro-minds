# 0028. Tests by a separate writer, locked; adversarial, independent review

- Status: Accepted
- Date: 2026-09-27
- Plan: D28 (PLAN §2)

## Context

Until now one Claude context planned a task, wrote its tests, implemented it and chose what the
`reviewer` saw. Since ADR 0027, `/run-phase` also removed the user's per-task plan approval, so
nothing independent stood between that context and a commit except a reviewer it briefed itself.

Three biases follow, each seen in the owner's earlier harnesses (`til`, `cortex-workspace`) and in
this repo:

- **Tests shaped to the implementation.** A context that already has the implementation in mind
  writes tests that fit it, so the tests stop encoding the task.
- **Tests weakened to pass.** An implementer that may edit tests grades itself.
- **Contaminated review.** A reviewer given the author's summary ("npm run check passes", the
  design rationale) inherits the author's blind spots. This happened in every review round of the
  ADR 0027 change. The `reviewer` was also a rule-catalog checker told that false positives cost as
  much as misses: it checked rules, it didn't try to break the change, and it had no shell to
  re-run a check or probe an edge case.

The practices that address these come from `cortex-workspace` (design rules R4, R11, R12;
constitution W1–W5), where two pilots showed review catching a real compatibility break and a
fresh reviewer catching a planted bug the tests missed.

## Decision

1. **Tests first, by a separate fresh context, then locked.** For every task that touches code or
   tests (defined once in `docs/dev-harness.md`; fixtures, config, docs, spike code and eval-case
   data are data, not code), the `test-writer` subagent writes the
   failing tests from artifacts only: the PLAN task text and the acceptance clauses `/start-task`
   derives. It never sees the implementation plan. Each test fails for the right reason, or is
   marked as guarding existing behavior. The tests are committed alone with a `Test-lock: <id>`
   trailer, before any implementation.
   What the tests need but don't define (a test dependency such as fast-check, fixtures the task
   delivers, a behavior-free seam) is committed first, on its own, as test infrastructure.
2. **The lock is a script, not a promise.** `npm run tests:locked -- <id>` (`scripts/tests-locked.ts`)
   fails if, after the lock commit, any test file (`*.test.ts[x]`, `__snapshots__/`, `fixtures/`,
   `e2e/`) was modified, deleted or added: committed, staged, unstaged or untracked. New snapshot
   files are the one exception. The lock commit may contain test files only. Each rule is proven
   by a test that plants the violation.
3. **A disputed test gets one redo.** If the implementer believes a locked test is wrong, a fresh
   `test-writer` gets the objection and may revise the tests once, as a second lock commit with a
   `Revision-reason:` trailer. The script refuses a third lock commit, so a second dispute stops
   the run for the user.
4. **The implementer never reviews; the reviewer never implements.** The `reviewer` runs in a fresh
   context with read-only intent. It gets a Bash tool to run checks and probes, and `/finish-task`
   compares the repository state before and after its run and stops if anything changed.
5. **Artifact-only review input.** The review prompt is fixed: the task id, the task text, the
   acceptance clauses and where the change is (`git diff` it can run itself). Nothing from the
   implementer: no summary, no claims that checks pass, no rationale.
6. **Adversarial mandate.** The reviewer's job is the strongest case against the change: it
   re-runs `npm run check` and the test lock itself, builds failure cases (hostile, malformed,
   empty and huge input, ordering and timing, Windows paths, partial failure) and probes them, and
   checks the tests encode the task rather than the implementation. It still reports only what it
   can point to. Every review lists what it probed (`probed` in the JSON, required by the eval
   parser), so an empty approval is visible. Findings are marked as introduced by the change or
   already present; only introduced ones block.
7. **Two review rounds**, then the user decides (was three).
8. **A separate security pass** by a second `reviewer` run, for tasks with a row in
   `docs/security/threat-model.md` (`planned: task <id>`) or whose first reviewer says the change
   adds or alters an external surface.
9. **A completeness audit at the end of each `/run-phase`:** a fresh agent maps every task clause
   and "Done when" clause of the phase to evidence before the pull request is marked ready.

Not adopted: `cortex-workspace`'s per-change spec folders and approval lines (the PLAN is the
spec; the user approves by starting `/run-phase` and by merging), and its tool-neutral canon (only
Claude Code is used here). Deferred with triggers in `docs/deferred-practices.md`: a different
model for review, a per-change retrospective log, and mutation testing (already deferred).

## Consequences

### Positive

- Tests encode the task, and a green run means the implementation met them, not the reverse.
- Review is independent and shows its work; `/run-phase` keeps an independent check per task even
  without a per-task human approval.
- The lock and the state comparison are mechanical, so they hold even when an agent's report
  doesn't.

### Negative

- Two commits per task (tests, then implementation), and one more subagent run per task (about
  $0.60 per role at `cortex-workspace`'s pilot sizes). No extra user time.
- `main` gets a commit whose tests fail (the test commit) before each implementation commit.
  `git bisect` has to skip `Test-lock:` commits.
- The lock runs on the same machine as the agent it checks, so it's a guardrail, not a boundary:
  an agent could rewrite history, or stop a test from running without touching a test file (an
  exclude in `vitest.config.ts`, a `.gitignore` entry). CI can't be the boundary here: it doesn't
  run the lock, and on a phase branch earlier locks fail by design. The boundary is the reviewer's
  `TEST-lock` rule and the user's review at merge.
- Reviewer probing takes longer, and the reviewer evals must be re-baselined after the prompt
  change.
- A lock is checked while its task is open. A later task's lock commit may legitimately change
  the same test files, after which the earlier task's check would report them; so each task's lock
  is verified before the next task's tests are written, never retroactively.

## Revisit when

- The golden-task or reviewer evals show the test writer or reviewer missing planted defects
  (strengthen), or the lock blocking legitimate work repeatedly (adjust the test-path rules).
- The MVP ships and per-task pull requests return (ADR 0027): keep all of this; it applies per
  task either way.

## References

- PLAN §2 D28, §11, §14
- ADR 0027; `docs/dev-harness.md`; `.claude/agents/reviewer.md`, `.claude/agents/test-writer.md`
- `cortex-workspace`: `docs/01-design-rules.md` (R4, R11, R12), `template/docs/constitution.md`
  (W1–W5), `docs/03-mental-traps.md` (T9, T13), `evals/pilots/`
