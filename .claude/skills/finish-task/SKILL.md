---
name: finish-task
description: Finish the current micro-minds PLAN task - snapshot the change in the index, run npm run check and coverage, confirm the reviewer eval cases due with the task were added, get a reviewer subagent pass on the staged diff, tick the PLAN checkbox (with the phase gate if it's the phase's last task), update standards and threat-model statuses, make the Conventional Commit, push the branch, open or update the pull request and wait for CI. It never merges; it ends with the merge command for the user. User-invoked only (or followed by /run-phase), because it commits and pushes.
argument-hint: [task-id] [--run-evals]
arguments: [id]
disable-model-invocation: true
allowed-tools: Read Grep Glob Edit Bash(git add *) Bash(git commit *) PowerShell(git add *) PowerShell(git commit *)
---

# Finish task

Run the gates below **in order. Each step must pass before the next.** On a failure, stop and report which step failed and why, quoting the output. Never paper over a failure: don't skip or weaken a test, add a `biome-ignore` or `v8 ignore`, lower a threshold, edit `uncovered.json` to hide a due rule, or use `--no-verify`. The rules behind these steps are in the root `CLAUDE.md` ("Before finishing") and PLAN §14.3.

Arguments: `$ARGUMENTS`. `--run-evals` means the user agrees to spend tokens on `npm run eval:harness` in steps 3 and 5; without it, ask first.

**Two branch modes** (ADR 0027):

- **Task branch** (`<type>/<id>-<slug>`): one task, one pull request. `BASE` means `--merge-base origin/main`.
- **Phase branch** (`phase/<n>-<slug>`, run by `/run-phase`): one commit per task, one pull request for the phase. Earlier tasks are already committed and reviewed, so this task's change is only what's staged: `BASE` means comparing the index with `HEAD` (no extra flag).

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
5. List the change: `git diff --cached BASE --name-only`. On a task branch that's `git diff --cached --merge-base origin/main --name-only` (the branch's commits plus the index, against where it left `origin/main`; `origin/main` is as of the last fetch). On a phase branch it's `git diff --cached --name-only` (this task only). Keep this file list for steps 2, 4 and 8.

## 1. `npm run check`

Run `npm run check` on its own and gate on **its exit code**. Never pipe it (`| tail`, `| grep`, `| Select-Object`): the pipeline reports the last command's status, so a failed check followed by `&& git commit` would commit anyway. Long output is fine; the tool truncates it.

Fail → **stop** and report which part failed (lint, typecheck or which test file).

## 2. Coverage

If the file list touches `apps/`, `packages/`, `.claude/hooks/` or `evals/`, run `npm run test:coverage` the same way (exit code, no pipe). A threshold miss means tests are missing; it's never fixed by changing the thresholds. Otherwise record "not needed" with the reason.

## 3. Eval coverage schedule

1. **Due rules:** read the schedule as it was before this task, with `git show origin/main:evals/harness/reviewer/uncovered.json` on a task branch or `git show HEAD:evals/harness/reviewer/uncovered.json` on a phase branch (an earlier task in the phase may have changed it), and list every entry whose `due` is exactly the task id.
2. For each due rule: the working copy of `uncovered.json` no longer lists it, and a case under `evals/harness/reviewer/cases/` in this change has it in `mustFind` (Grep the `expected.json` files in the file list). Missing either → **stop**: the PLAN tick in step 5 would make `coverage.test.ts` fail.
3. **Overdue:** no entry in the working `uncovered.json` may have a `due` task that's ticked in `docs/PLAN.md` (step 1 ran `coverage.test.ts`, so this should already hold).
4. **Run the new cases** (`evals/harness/README.md`, "Adding a case"): `npm run eval:harness -- <case> ...`. It spends tokens: run it only with `--run-evals`; otherwise ask the user and **stop** until they answer. If they decline, record "not run" for the PR body.

## 4. Reviewer pass

1. Produce the diff: `git diff --cached BASE` (plus `--stat` for the summary), as in step 0.5.
2. Invoke the `reviewer` subagent. It has no shell, so paste the **complete, untrimmed** diff into its prompt in a `diff` fence, preceded by the task id and the task line from PLAN. If the diff is too large for one prompt (roughly over 3,000 lines), split it by package with `-- <paths>`, run one reviewer per part, and tell each reviewer which part of the change it has.
3. Parse the **last** fenced `json` block of each reply: `{ "findings": [{ ruleId, severity, file, line, summary }], "verdict" }`. If it's missing or doesn't parse, re-invoke once; if it fails again, **stop**. Any `blocker` or `major` finding counts as changes requested, whatever the verdict says.
4. **blocker/major:** fix it within the task's scope, re-stage (step 0.4), and restart from step 1. After 3 review rounds with blockers or majors left, **stop** and report them.
   - If you believe a finding is a false positive, don't skip it: **stop** and show the user the evidence. A confirmed false positive is an eval trigger (`evals/harness/README.md`, "Triggers"); note it for a follow-up.
5. **minor:** fix it (and restart from step 1), or write a one-line justification for the PR body.
6. Keep the final verdict, the rounds it took, and the findings fixed or justified, for step 8.

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

Stage the doc changes, then run `npm run check` again (step 1 rules). The tick makes `coverage.test.ts` treat this task as done, and `docs.test.ts` checks links. If step 6 did more than flip statuses (a new ADR, new prose), run step 4 again on the new diff.

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
- [x] Reviewer eval cases for rules due with <id>: <case dirs> (`npm run eval:harness -- <cases>`: pass / not run)
- [ ] CI green on ubuntu, macos and windows
- [ ] <any manual check from the task text or the phase's "Done when">

## Reviewer
Verdict: approve after <n> round(s). Fixed: <ruleId: one line each>. Minors not fixed: <ruleId: justification>.

## Docs
- <standards, threat model, ADR, protocol doc changes, or "none">
```

**Phase pull request body:** a `## Phase <n>: <title>` heading with the phase's **Goal**, then one section per task, appended as each task finishes:

```markdown
### <id> `<sha>` <subject>
- <what changed, one bullet per area>
- Checks: check pass; coverage <pass / not needed>; eval cases <cases / none due>; reviewer approve after <n> round(s) (<fixed or justified findings, or "no findings">)
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
| 3 eval schedule | <rules due> covered by <cases>; new cases run: pass / not run |
| 4 reviewer | approve after <n> round(s); <k> fixed, <m> minor justified |
| 5 tick | [x] <id>; phase gate: n/a / pass (<baseline row>) |
| 6 docs | <files changed> |
| 7 commit | <sha> <subject>; lint:commits OK |
| 8 PR | #<number> <url>; CI green |

Review the pull request, then merge it yourself:

gh pr merge <number> --merge --delete-branch
```

Then **stop**.
