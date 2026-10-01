# Backlog

Review findings triaged as "later" (ADR 0031): already present before the change that surfaced
them, or belonging to a later task. `/start-task` lists the items that touch a task; the reviewer
reads this file so it doesn't report them as new. Remove an item in the change that resolves it.

## Harness friction

Friction with the harness itself (a hook that blocks legitimate work, a flaky test, an agent that
stalls, a gate that costs more than it catches), one line each with the date and where it bit.
At each phase gate, spend ten minutes on this list: each entry becomes a fix, an eval case, an
accepted cost (moved to the doc that owns it), or stays. A blameless record, not a to-do list.

**Log on first occurrence, act on the second**, and diagnose the cause before choosing the fix:
the same symptom can have different causes, and two occurrences with different causes are two
first occurrences. Two kinds act at once, without waiting for a repeat: an escaped defect (below)
and anything security-shaped. (From cortex-workspace's operator feedback loop.)

| Friction | Seen | Outcome |
|---|---|---|
| The guard blocked legitimate PowerShell and scripts (`-Pattern` read as recursive; a `~` in text next to a project `.claude/` path) | Phase 1 and Phase 2 | Recursion: fixed by an exemption list. `~` in text: accepted cost (write such text with a file tool); see the guard row below |
| A reviewer stalled with no output on a 39-file diff | 2026-09-29, consolidation | Cause: a stream timeout ("no progress for 600s"), not the diff outgrowing a context. `/finish-task` now splits reviews above about 1,500 changed lines, which also bounds each run; a first occurrence, so watch for a second |
| Time-bound tests failed under unrelated CPU load (the format hook's subprocess test, scrubber step bounds) and an unseeded property failed CI at random | 2026-09-29 | Properties seeded; subprocess tests given their spawn timeout; the scrubber's linearity is checked by growth (best of three, 2× margin) with a 5 s hang cap. Still failed once in three local runs while a game held most of the CPU: watch CI. Seen again 2026-09-30 (2.7 review): `scrub.performance.test.ts` failed while the reviewer's probes ran in parallel, and passed alone; the same cause (CPU contention), so the second occurrence: decide at the Phase 2 gate whether the step bounds move to a benchmark outside `npm run check` |
| Review rounds re-found settled scrubber gaps | Phase 2, task 2.2 | Triage and the reviewer's context (ADR 0031) |
| The guard's `.env` rule blocked two Bash commands that only held a regex in an argument (`k.split('.*')`, `/(… .*?\| )/`): `isEnvFileName` reads a last path segment that starts with `.` and holds a glob character as a dot-glob that could expand to `.env` | 2026-09-30, tasks 2.6 and 2.7 (twice, same cause) | Worked around with the Write/Edit tools. Second occurrence: fix at the Phase 2 gate (for example, only treat a token as a path glob when it has no quotes, parentheses or regex syntax around it), with an eval case for each shape |

## Escaped defects

A bug found after a review approved the change that introduced it: the most important signal the
harness has. Each one gets a retro at once: why did review miss it (the category wasn't checked,
or it was and the probe was too shallow), and a planted eval case made from it
(`evals/harness/README.md`, "Triggers").

| Defect | Introduced in | Found | Why review missed it | Eval case |
|---|---|---|---|---|
| None recorded yet | | | | |

## Deferred findings

| Item | Source | Where it belongs |
|---|---|---|
| A hostile repo's filter drivers (`filter.<name>.smudge`/`clean` in its config, named from `.gitattributes`) run when the worktree manager checks out (`git worktree add`) or runs `git status`; git has no single switch to disable them. Options: `worktree add --no-checkout` then a checkout with each attribute-named driver overridden by `-c`, or accept it because the agent CLI runs in that repo anyway (threat model, A5) | 2.5 | An ADR or an accepted risk before Phase 3 (threat model row "filter drivers", status gap) |
| `killTree` runs `taskkill.exe` by bare name, and libuv looks in the current directory before PATH on Windows; resolve it absolutely (`%SystemRoot%System32`, from config) | 2.6 review (note) | Task 2.11 (lifecycle, orphan kill) |
| Ended sessions stay in the manager's map with their headless xterm alive; evict or dispose them | 2.6 review (note) | Task 2.11 or 2.12 (session records in SQLite, resume) |
| Tests for the worktree manager fixes from the 2.5 review, which the lock kept out of 2.5: a locked worktree is refused before anything is touched; a failed `git worktree remove` restores the untracked links it unlinked; a write after the dirty check makes git refuse (no `--force` without `confirm`); `list` under a home reached through a symlink or junction. Reproduced by hand in the 2.5 review round | 2.5 review | Follow-up tests in `worktree-manager.test.ts` under a new lock, next time the worktree manager is touched (2.11 prune, 2.12 resume) |
| The server side of "commits not pushed or merged" (PLAN §5.5 step 6): the worktree manager reports dirty only | 2.5 | Task 3.8 (removal warnings) |
| Confirm with real Claude that `--` before the first prompt ends its options, so a prompt starting with `-` isn't read as a flag | 2.4 | Manual check in Phase 2's "Done when" run with real Claude |
| The registry passes an adapter's own `ts` and `id` at runtime (the conformance suite enforces them in tests); consider stamping them from the context | 2.3 review | The next change to the registry (2.7 kept the adapters' own ids and ts; the conformance suite enforces them) |
| `tool.name`, `agentId`, `parentAgentId`, `tool.useId` and `usage.model` are neither scrubbed nor capped (hard rule 8 covers `text`, `tool.summary` and `raw`); consider a length cap in the registry | 2.3 security review | Task 2.9 (security tests; the 2 MiB `/hooks` body limit from 2.7 bounds them meanwhile) |
| `scrubRaw()` scrubs an object reachable along several paths once per path (exponential for a shared-reference DAG); not reachable from `JSON.parse` input | 2.2-fix3 review | Only if in-process values ever reach `scrubRaw()` |
| Scrubber: Sourcegraph `sgp_local_` and Lob `live_pub_`/`test_pub_` keys have no known-prefix pattern | 2.2-fix3 review | Scrubber corpus, when next touched |
| Scrubber: a CI run on macOS once drew a Twilio-shaped key (`SK` + 32 hex) whose hex survived; not reproduced in 26,000 runs of that shape since (the properties are seeded now) | CI, 2.4 push | Scrubber, if it recurs |
| Scrubber: the seed sweep found 40-character mixed-case letter-only tokens that pass as words (`digitFreeToken(-1578093748, 40, LETTERS)` and `digitFreeToken(140643653, 40, LETTERS + '-_')` in `scrub.test-helpers.ts`; fast-check seed 444464). Within the accepted "pronounceable mixed-case" gap; add them as rows if `wordLike` is ever tightened | Consolidation seed sweep | Scrubber, when next touched |
| Tests for 2.7 behavior the lock kept out: the receipt time is taken on receipt, not when a queued payload is processed (make processing lag behind a slow subscriber and check `ts`); a throwing tick subscriber neither escapes the timer nor drops the other sessions' ticks; a stored row that no longer parses is skipped by `read()`; the default rate limit applies when the caller passes none | 2.7 review | Follow-up tests under a new lock when the server is assembled (task 2.8) |
| Before deleting `spikes/phase-1/` at the end of Phase 2 (PLAN schedules it): move the capture sink and fixture scrubber somewhere permanent for the `record-fixture` skill (StopFailure and `elicitation_dialog` still need recording), and move the `.md` evidence the ADRs and the protocol doc cite into `docs/protocols/` | Consolidation (ADR 0031) | Phase 2 end |
| Conformance suite: after the trim to 18 broken adapters, some rules in `conformance.test-helpers.ts` have none that trips them (events: `provider`, `sessionId`, ids from `ctx.newId`, the root agent id, `v`; facts-only: mood, attention; launch: the token in a file name, env pointing into the worktree, absolute or separator file names, non-string args or env, a throwing `launch`). Add one broken adapter per rule | Consolidation review | Before the Phase 5 adapters rely on the suite |
| Guard hook gaps present before and after ADR 0031's change (second review round): a change to home not written as a bare home reference (bare `cd`, `cd ~/.`, an absolute home path, `cd ../..` from inside home, `cd ~user`), and recursion via `cp -a`, `rsync -a`, `Compress-Archive`, `grep --dereference-recursive`, `rg.exe`, `cmd /c dir /s`, `-Dep`, or a cmdlet after `$x =`. Parsing can't close these for good; OS-level isolation can | Consolidation, guard review round 2 | The sandbox spike (deferred-practices, trigger fired) |
| Run the test lock in CI, with the base branch's copy of `scripts/tests-locked.ts`, as cortex-workspace's `ci-gates.sh` does, so a rewritten history or an edited checker can't pass it locally. Design questions first: on a phase branch, later tasks' lock commits legitimately change earlier tests, so CI must check each task's lock over its own commit range only; one-off edits of locked tests the user approved (as in the ADR 0031 consolidation) need an escape an agent can't grant itself (not a commit trailer); and in this solo repository the user's merge, not a CODEOWNERS approval (GitHub won't let you approve your own PR), is the human check | Comparison with cortex-workspace, 2026-09-30 | An ADR, before Phase 3 or the first unattended run |
| Guard hook: a `node -e` one-liner was denied by the `.env` rule (a false positive; the exact command wasn't kept). Reproduce it with `decide()` and add a table row when it recurs | Consolidation (ADR 0031) | Harness, when it recurs |
| The `statusline-*` fixtures have no consumer (the status line isn't used, D30), while Phase 2's "Done when" asks for a replay test per fixture | 2.4 | Phase 2 end: delete them or mark them as reference |
