# Deferred and rejected practices

Practices we considered and chose **not** to adopt yet. Each entry says why, and which trigger
should bring it back. This page exists so that a future session (human or agent) finds the
earlier reasoning instead of re-debating it, and notices when a trigger has fired.

**How to use it**

- Before proposing a new practice, search this page. If it's here, check whether its trigger has
  fired. If it hasn't, don't re-propose it without new evidence.
- When a trigger fires, open an issue or plan task, write an ADR if the change touches PLAN §2,
  and move the entry to "Adopted" at the bottom with a link.
- When you decide against a practice, add an entry here in the same PR.

Status values: **Deferred** (likely later, waiting on a trigger) or **Rejected** (not planned;
reopen only with new evidence).

---

## Harness (AI developer experience)

### `Stop` hook that blocks Claude from ending a session until checks have passed

- **Status:** Deferred (decided 2026-09-27)
- **What:** a `Stop` hook in `.claude/settings.json` that refuses to let Claude end its turn while
  tracked files have changed and `npm run check` hasn't passed since the last edit.
- **Why not now:**
  - It's hard to get right. It needs state ("was check run after the last edit?"), it
    misfires on exploratory, docs-only or mid-task turns, and a blocked Stop can loop.
  - Being blocked repeatedly trains people to bypass hooks.
  - The `/finish-task` skill gets most of the benefit with no friction.
- **Revisit when:** the golden-task eval or real sessions show Claude finishing tasks without
  running `npm run check`, the reviewer or the commit steps, even with `/finish-task` available.
- **If adopted:** only block when tracked source files changed; record check runs through a
  `PostToolUse` hook on the check command; have a clear escape hatch (docs-only changes, explicit
  user override); deterministic tests in `evals/harness/`; an ADR.

### Claude merges its own pull requests

- **Status:** Rejected (decided 2026-09-27, ADR 0027)
- **What:** allowing `gh pr merge` (or auto-merge) so a green, reviewed pull request lands
  without the user.
- **Why not:**
  - The merge is the only step where a human looks at the change. The reviewer is a model too,
    so without it an AI would approve its own work.
  - Common practice for coding agents is the same split: the agent pushes and opens the pull
    request, a human merges. Claude Code's auto-mode classifier also refuses unreviewed merges.
  - The cost is small: one command per task, or one per phase with `/run-phase`.
- **Revisit when:** the repo has a second human reviewer or required approvals, so a merge after
  their approval is no longer Claude's own sign-off.

### Specialized reviewer agents (`security-reviewer`, `ui-reviewer`)

- **Status:** Deferred. The security *pass* was adopted in ADR 0028 as a second run of the same
  `reviewer` in `mode: security`, for tasks the threat model names; only a separate agent
  definition stays deferred.
- **Why not now:** one `reviewer` with a rule catalog is easier to evaluate and maintain. Splitting
  it without evidence adds cost and overlapping findings.
- **Revisit when:** reviewer eval recall for `SEC-*`/`HR3`/`HR4` or UI rules drops below the
  threshold across trials, or real misses cluster in one area.

### A different model for review than for implementation

- **Status:** Deferred (decided 2026-09-27, ADR 0028)
- **What:** run the `reviewer` (`model:` in its frontmatter) on a different model from the
  implementer, so their blind spots are less correlated.
- **Why not now:** independence already comes from a fresh context, artifact-only input and an
  adversarial mandate. There's no evidence that correlated blind spots remain, and only one model
  family is available here.
- **Revisit when:** reviewer evals or real reviews show misses that the implementer's model also
  makes (the same wrong assumption in code and review), or a second model family becomes
  available.

### A per-change pipeline log and retrospective

- **Status:** Trigger fired (2026-09-29): guard friction recurred in Phase 1 and Phase 2. Adopted
  in its light form: the "Harness friction" list in [backlog.md](backlog.md), reviewed for ten
  minutes at each phase gate. A per-change log stays deferred.
- **Originally:** Deferred (decided 2026-09-27)
- **What:** `til` and `cortex-workspace` append a row per change (gates, findings, escaped
  defects) and run a short retrospective that turns friction into approved process diffs.
- **Why not now:** each PR body already records the gates, the reviewer's rounds, findings and
  probes, and the phase PR collects them per phase. Harness changes already need evidence
  (principle 2), which the eval triggers supply.
- **Revisit when:** a defect escapes review into `main` and nothing records how, or the same
  friction shows up in two phase runs.

### Spec folders with a human approval line per change

- **Status:** Rejected (decided 2026-09-27, ADR 0028)
- **What:** `cortex-workspace`'s change folders (proposal, design, tasks, lock) and a written
  approval line before tests are written.
- **Why not:** `docs/PLAN.md` is already the spec, task by task, and the user approves by starting
  `/run-phase` and by merging. A second spec per task would duplicate the plan (drift by
  construction).
- **Revisit when:** work starts arriving that the PLAN doesn't describe (post-MVP features, bug
  reports from use), which then needs its own written acceptance criteria.

### Claude Code sandbox mode for this repo

- **Status:** Trigger fired (Phase 1 is done). Next: a short spike and an ADR. Evidence for it:
  the guard's command parsing produced false positives in two phases and, in ADR 0031's review,
  bypasses whenever a rule was narrowed; OS-level isolation (Claude Code's sandbox where it runs,
  or a separate user, WSL or a devcontainer on Windows) doesn't depend on parsing. Check first
  what the sandbox supports on native Windows.
- **Originally:** Deferred
- **Why not now:** we don't yet know what filesystem and network access agents need here (PTYs,
  `git worktree`, local servers). Sandboxing too early would break Phase 1 spike work.
- **Revisit when:** Phase 1 is done. Run a short spike and write an ADR.

---

## Engineering

### Release tooling (changelog, semver tags, release-please)

- **Status:** Deferred
- **Why not now:** a local app distributed by `git clone`, with no releases yet.
- **Revisit when:** Phase 8 (packaging), or the first time someone other than the owner runs it
  from a tag.

### OpenSSF Scorecard and SBOM generation

- **Status:** Deferred
- **Why not now:** pinned actions, Dependabot, CodeQL, secret scanning and audit already cover
  most of the risk. Scorecard and SBOMs matter most for published artifacts.
- **Revisit when:** we publish packages or binaries (Phase 8).

### Mutation testing (Stryker) for the reducer and severity rules

- **Status:** Deferred
- **Why not now:** fixture replay plus property-based tests come first. Mutation testing is slow and
  most useful once those suites are mature.
- **Revisit when:** after Phase 3, if reducer bugs slip past the existing tests.

### Separate PTY-owning process so agents outlive the server

- **Status:** Deferred (PLAN D20)
- **Why not now:** it roughly doubles server complexity. Lightweight resume covers restarts.
- **Revisit when:** resume proves insufficient in daily use (for example, losing in-flight turns
  on every dev restart is too painful).

---

## Adopted

Entries move here, with a link to the ADR or PR, once a trigger fires and the practice is
adopted.

_None yet._
