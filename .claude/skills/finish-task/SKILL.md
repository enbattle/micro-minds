---
name: finish-task
description: Finish the current micro-minds PLAN task - snapshot the change in the index, run npm run check and coverage, get one adversarial reviewer pass on the staged diff and triage its findings (ADR 0031), tick the PLAN checkbox (with the phase gate if it's the phase's last task), update standards and threat-model statuses, make the Conventional Commit, push the branch, open or update the pull request and wait for CI. It never merges; it ends with the merge command for the user. User-invoked only (or followed by /run-phase), because it commits and pushes.
argument-hint: [task-id] [--run-evals]
arguments: [id]
disable-model-invocation: true
allowed-tools: Read Grep Glob Edit Bash(git add *) Bash(git commit *) PowerShell(git add *) PowerShell(git commit *)
---

# Finish task

Run the gates below **in order. Each step must pass before the next.** On a failure, stop and report which step failed and why, quoting the output. Never paper over a failure: don't skip or weaken a test, add a `biome-ignore` or `v8 ignore`, lower a threshold, or use `--no-verify`. The rules behind these steps are in the root `CLAUDE.md` ("Before finishing") and PLAN §14.3.

Arguments: `$ARGUMENTS`. `--run-evals` means the user agrees to spend tokens on `npm run eval:harness` in steps 3 and 5; without it, ask first.

**Two branch modes** (ADR 0027):

- **Task branch** (`<type>/<id>-<slug>`): one task, one pull request. `BASE` means `--merge-base origin/main`.
- **Phase branch** (`phase/<n>-<slug>`, run by `/run-phase`): one pull request for the phase. Earlier tasks are already committed and reviewed, so this task's change is its test-infrastructure commit (if any), its lock commit(s) and what's staged: `BASE` means the parent of the task's **first** commit carrying a `Test-infra: <id>` or `Test-lock: <id>` trailer (`git log --format=%H -E --grep="^Test-(infra|lock): <id>$" origin/main..HEAD`, the last line, then `^`). The reviewer must see the infrastructure commit to check it holds no implementation. A task with neither (docs only) uses `HEAD`.

**Code tasks** (ADR 0028): a task whose change touches code or tests, as defined in `docs/dev-harness.md` ("Which tasks get locked tests"), must already have its `Test-lock: <id>` commit from `/start-task` step 6. Data and docs (fixtures, config, `*.md`, `spikes/`, eval-case data) need none. A code task ends as: an optional test-infrastructure commit, the lock commit (plus at most one revision), then the implementation commit this skill makes.

## Git state (captured before you read this)

Current branch:
!`git branch --show-current`

Uncommitted changes (`git status --short`):
!`git status --short`

## 0. Task and snapshot

1. **Task id:** the argument is `$id` (empty if none was given; ignore it if it's a flag). Use it if set; otherwise take it from the branch name, `<type>/<id>-<slug>` (`<id>` is `<phase>.<n>`, for example `2.7` or `4a.3`). A phase branch never implies the id: it must be given. Otherwise ask and **stop**.
2. On `main`: **stop.** Tasks finish on a task branch (`/start-task` sets one up).
3. The task line in `docs/PLAN.md` must exist and be unticked (`- [ ] <id> `). Read it; the steps below check against it.
4. **Snapshot decision: review what is staged.** Everything the task changes must be staged (or, on a task branch, already committed on it), and nothing may be unstaged or untracked. The check, the coverage run, the reviewer and the commit then all see the same bytes.
   - Stage the task's files by explicit path: `git add -- <path> ...`. Never `git add -A`, `git add .` or `git commit -a`: other sessions may share this tree.
   - Anything in `git status --short` that isn't the task's (another task, a scratch file): list it and **stop**. The user moves it out of the way; you don't stash, reset or delete it.
   - Pass when every `git status --short` line has a space in the second column and none is `??`.
5. List the change: `git diff --cached BASE --name-only`. On a task branch that's `git diff --cached --merge-base origin/main --name-only` (the branch's commits plus the index, against where it left `origin/main`; `origin/main` is as of the last fetch). On a phase branch it's the same command with BASE as defined above (the parent of the task's first `Test-infra: <id>` or `Test-lock: <id>` commit), so the list covers this task only, test infrastructure included. Keep this file list for steps 2, 4 and 8.
6. **Code task without a lock commit:** **stop**. Its tests must come from the test writer first (`/start-task` step 6); tests the implementer wrote don't count.

## 1. `npm run check`

Run `npm run check` on its own and gate on **its exit code**. Never pipe it (`| tail`, `| grep`, `| Select-Object`): the pipeline reports the last command's status, so a failed check followed by `&& git commit` would commit anyway. Long output is fine; the tool truncates it.

Fail → **stop** and report which part failed (lint, typecheck or which test file).

For a code task, then run `npm run tests:locked -- <id>` the same way (on a task branch; on a phase branch add `--base origin/main`). It checks **only the unit that is open now**: an earlier task's lock is never re-checked, because a later task's lock commit may legitimately have changed the same tests (ADR 0028). Fail → **stop**: a test was changed after the lock. Restore it from the lock commit (`git restore --source=<lock sha> -- <path>`, or revert the commit that changed it), and only once the lock passes again consider the one revision (`/start-task` step 6.6); never edit it yourself.

## 2. Coverage

If the file list touches `apps/`, `packages/`, `.claude/hooks/` or `evals/`, run `npm run test:coverage` the same way (exit code, no pipe). A threshold miss means tests are missing; it's never fixed by changing the thresholds. Otherwise record "not needed" with the reason.

## 3. Eval cases (only on a trigger)

Evals grow from real misses, not from a schedule (ADR 0031; triggers in `evals/harness/README.md`, "Triggers"). Add a case in this change only if step 4's triage confirmed a false positive, this task fixes a bug an earlier review missed, or the task adds a rule to the reviewer's catalog. Run new cases with `npm run eval:harness -- <case> ...` only with `--run-evals`; otherwise ask the user first. Record "none" when nothing triggered.

## 4. Adversarial review, then triage (ADR 0028, ADR 0031)

You implemented this change, so you don't review it, and you don't brief the reviewer: it gets artifacts and the repository's own decisions, never your claims.

1. **Snapshot the repository** for step 4.4: `git rev-parse HEAD`, `git status --porcelain -uall`, `git diff --cached | git hash-object --stdin`, `git for-each-ref | git hash-object --stdin` (branches and tags) and `git config --local --list | git hash-object --stdin`. Keep the five outputs.
2. **Security due?** Yes if `docs/security/threat-model.md` has a row naming this task (`planned: task <id>` or `tasks …, <id>`). The security checks then run in the same review.
3. **Invoke the `reviewer` subagent** (never a fork) once, with exactly this prompt and nothing else. No summary of the change, no claim that checks pass, no rationale:

   ```
   Review task <id> of micro-minds. mode: standard; security: <yes|no>
   Task (docs/PLAN.md): <the task line, verbatim>
   Acceptance clauses: <the clauses from /start-task step 4.6, verbatim>
   Branch mode: <task|phase>. The change: git diff --cached <BASE>
   Code task: <yes|no> (if yes, the test lock: npm run tests:locked -- <id><phase: --base origin/main>)
   Settled already (don't re-report as new): docs/security/threat-model.md "Residual and accepted risks", docs/backlog.md, docs/decisions/.
   ```

   Parse the **last** fenced `json` block: `{ findings: [{ ruleId, severity, file, line, summary, introduced }], probed, externalSurface, verdict }`. If it's missing, doesn't parse, or `probed` is empty, re-invoke once; if it fails again, **stop**. If security wasn't due but the reviewer set `externalSurface: true`, run one more review with `security: yes` and add its findings.
4. **Check the reviewer changed nothing:** repeat step 4.1. Any difference: **stop** and report it. Don't use that review.
5. **Triage every finding** before fixing anything. Check it against the code and the repository, and give each one outcome with its evidence:
   - **Fix**: reproduced (or plainly true from the code), introduced by this change (`introduced: true`), and in this task's scope.
   - **Backlog**: `introduced: false`, or it belongs to a later task. Add it to `docs/backlog.md` with its source (`<id> review`) and stage that.
   - **Reject**: it contradicts an accepted risk, an ADR or a PLAN decision. Cite the document and section.
   - **Needs the user**: you would reject or defer a **blocker**, or you disagree about scope. **Stop** and show the evidence. A confirmed false positive is an eval trigger (step 3).
   Minors follow the same outcomes; a fix is optional, a one-line reason is not.
6. **Fix** the "fix" findings within the task's scope, re-stage (step 0.4), and rerun steps 1–2. Never fix a finding by editing a locked test. A second review round only when a fix changed behavior beyond the finding it fixed; after a second round with introduced blockers or majors left, **stop** for the user.
7. Keep, for step 8: the triage table (finding, severity, outcome, evidence), the rounds, and the reviewer's `probed` list.

## 5. Tick the task

1. In `docs/PLAN.md`, change exactly `- [ ] <id> ` to `- [x] <id> ` on the task's line, and stage it.
2. **Phase gate:** if that was the last unticked task of its phase, run the checklist in `evals/harness/README.md#phase-gate` (PLAN §14.6):
   - `npm run eval:harness -- --trials 3`. It spends tokens (about $2 at the last baseline): only with `--run-evals`, otherwise ask and **stop**. Every case must pass 2 of 3 trials and recall must meet the threshold; a failure **stops** the task here.
   - Add the baseline row the runner prints to the history table in `evals/harness/README.md`.
   - Review the threat-model rows for the phase's tasks (`docs/security/threat-model.md`, "How to use this document").
   - Report each clause of the phase's **Done when** as met, unmet or needs manual check, with evidence. Unmet clauses mean the phase isn't complete; say so plainly.

## 6. Docs

- `docs/engineering-standards.md`: for each row whose Status is `Scheduled:` with this id, remove the id from the list. When no ids are left and the check exists, set the status to `Enforced` and make sure "Enforced by" names the check. If the check isn't in place, the task isn't done: **stop**.
- `docs/security/threat-model.md`: rows with `planned: task <id>` become `enforced by test`, with the test file in "Where". A row whose test didn't land stays, and you report it.
- If the change alters a PLAN §2 decision: an ADR from `docs/decisions/0000-template.md` with the next number, and PLAN §2 updated to match.
- Any other doc the change made stale: `docs/protocols/*.md`, package `CLAUDE.md` files, `docs/architecture.md`, `docs/glossary.md`.

Stage the doc changes, then run `npm run check` again (step 1 rules); `docs.test.ts` checks links. A new ADR or new prose in step 6 is part of the reviewed change: write it before step 4 when you can; otherwise run step 4 again on the doc-only diff.

## 7. Commit

1. `git status --short`: only staged entries, all in the step 0.5 list or the step 5–6 docs.
2. **Subject**, the rules `scripts/lint-commits.ts` enforces: `type(scope): description`; type is one of `feat fix docs style refactor perf test build ci chore revert`, matching the branch prefix (on a phase branch, the type `/start-task` step 2 gives this task); scope is optional, lowercase letters, digits, `-` or `/` (the package or area: `server`, `web`, `shared`, `hook-relay`, `claude`, `harness`); description starts with a lowercase letter, digit or backtick and doesn't end with a period; at most 100 characters. End it with the id: `feat(server): add hook ingest and event store (2.7)`.
3. **Body:** what changed and why, wrapped at about 72 columns, in the style of `git log -n 5`. Then a line `Task <id>.` on its own, which `/phase-status` matches.
4. **Trailer:** check the convention with `git log -n 10 --format='%(trailers:key=Co-Authored-By)'`. Use the co-author line your own harness instructions give for this session; if they give none, follow the format in the log with the model you actually are. Never copy a model name from history.
5. Write the message to a file **outside the working tree** (your scratchpad directory, or the OS temp directory) and run `git commit -F "<path>"`. A file avoids shell quoting of backticks and `$` in PowerShell and bash.
6. Run `npm run lint:commits`. If only the commit you just made fails, fix its message with `git commit --amend -F "<path>"` (message only, nothing newly staged) and run it again. If an earlier commit on the branch fails, **stop**: rewording it needs an interactive rebase, which the user does.
7. `git status --short` is clean.

## 8. Push, pull request and CI

Claude pushes the branch and opens the pull request, but **never merges** (ADR 0027): `gh pr merge` is denied, and the merge is the user's review. Pushes to `main`, force-pushes and deletes are denied too; don't look for another route. If a push or `gh` call is refused, **stop** and give the user the exact command instead.

Write the pull request body to a file **outside the working tree** (as in step 7.5).

**Task branch:**

1. `git push -u origin <branch>`.
2. `gh pr create --base main --head <branch> --title "<subject>" --body-file "<path>"`. The title is the commit subject, so it passes the CI title lint.
3. `gh pr checks <number> --watch` and gate on its exit code. Only once it exits 0, tick the body's "CI green" box and update it with `gh pr edit <number> --body-file "<path>"`. A red check: read the failing job's log (`gh run view <run-id> --log-failed`), fix it within the task on the same branch as a new commit (`fix(<scope>): <what> (<id>)`), re-run steps 1–4 and 7 for the fix, and push again. After 2 failed fix attempts, **stop** and report.

**Phase branch** (`/run-phase` continues after this step; nothing is reported to the user per task):

1. `git push -u origin <branch>`.
2. If the branch has no pull request yet (`gh pr view <branch>` fails), create it as a draft, so CI runs on every task: `gh pr create --draft --base main --head <branch> --title "<title>" --body-file "<path>"`, with the phase body below. The CI title lint needs a Conventional Commit, so build the title yourself: type `feat`, unless every task in the phase has the same other type (for example all `docs`); no scope; then the phase title **lowercased**, without parentheticals or markers such as `← MVP complete`, then `(phase <n>)`. For example `feat: claude protocol spike (phase 1)` or `feat: server core (phase 2)`. Check it before creating the PR with `npm run lint:title -- "<title>"`. Otherwise append this task's section to the body: `gh pr view <branch> --json body --jq .body` into the file, add the section, then `gh pr edit <branch> --body-file "<path>"`.
3. `gh pr checks <branch> --watch`, handled as for a task branch.

**Task pull request body** (ends with the PR attribution line your harness instructions give, if any):

```markdown
## Summary
- <what changed, one bullet per area>

Task <id> (docs/PLAN.md §10).

## Test plan
- [x] `npm run check`
- [x] `npm run test:coverage` (or: not needed, <why>)
- [x] Tests by the test writer, locked in <sha> (`npm run tests:locked -- <id>`: pass) (or: not a code task)
- [x] Eval cases: <new cases and result, or "none triggered">
- [ ] CI green on ubuntu, macos and windows
- [ ] <any manual check from the task text or the phase's "Done when">

## Review
Verdict: <verdict>, <n> round(s); security checks: <yes/no>.

| Finding | Severity | Outcome | Evidence |
|---|---|---|---|
| <ruleId: one line> | <severity> | fix / backlog / reject / user | <what was reproduced, or the cited doc> |

Probed: <the reviewer's probed list, condensed>.

## Docs
- <standards, threat model, ADR, protocol doc changes, or "none">
```

**Phase pull request body:** a `## Phase <n>: <title>` heading with the phase's **Goal**, then one section per task, appended as each task finishes:

```markdown
### <id> `<sha>` <subject>
- <what changed, one bullet per area>
- Checks: check pass; tests locked in <sha> (or not a code task); coverage <pass / not needed>; eval cases <cases / none triggered>; review <verdict>, <n> round(s), security checks <yes/no>
- Triage: <finding → outcome (evidence), one line each, or "no findings">
- Probed: <the reviewer's probed list, condensed>
- Manual: <checks the user still has to do, or "none">
```

`/run-phase` adds the phase gate and "Done when" sections at the end.

**Task branch only**, end with:

```
## Task <id> ready: <subject>

| Step | Result |
|---|---|
| 1 check | pass |
| 2 coverage | pass / not needed (<why>) |
| 3 eval cases | <new cases: pass / not run, or "none triggered"> |
| 4 review | <verdict>, <n> round(s); <k> fixed, <b> backlog, <r> rejected; security checks <yes/no> |
| 5 tick | [x] <id>; phase gate: n/a / pass (<baseline row>) |
| 6 docs | <files changed> |
| 7 commit | <sha> <subject>; lint:commits OK |
| 8 PR | #<number> <url>; CI green |

Review the pull request, then merge it yourself:

gh pr merge <number> --merge --delete-branch
```

Then **stop**.
