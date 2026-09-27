---
name: start-task
description: Start a micro-minds PLAN task - validate the task id against docs/PLAN.md, check the git state and propose a task branch, brief everything due with the task (full task text, the phase's "Done when", referenced PLAN sections and ADRs, package CLAUDE.md files, reviewer eval cases due from evals/harness/reviewer/uncovered.json, scheduled engineering-standards and threat-model rows), then write a plan and stop for approval before any code. Use when asked to start, begin, pick up or plan a PLAN task ("start 2.7", "let's do the next task"). Takes the task id and an optional --branch flag.
argument-hint: <task-id> [--branch | --branch=<name>]
arguments: [id]
allowed-tools: Read Grep Glob Bash(git switch -c *) PowerShell(git switch -c *)
disallowed-tools: Edit Write NotebookEdit
---

# Start task `$id`

You prepare one PLAN task and stop at an approved plan. **In this turn you write no files** (Edit and Write are disabled until the user replies) and change no git state except creating a branch as described in step 2. The workflow is in [docs/dev-harness.md](../../../docs/dev-harness.md#task-workflow); the rules are in the root `CLAUDE.md` ("Working style"). Don't restate them; apply them.

Full arguments: `$ARGUMENTS`

## Git state (captured before you read this)

Current branch:
!`git branch --show-current`

Uncommitted changes (`git status --short`; nothing listed means clean):
!`git status --short`

## 1. Validate the task id

1. If `$id` is empty or starts with `--`, find the next task the way the `phase-status` skill does (first unchecked task of the earliest unfinished phase), say which one, and ask the user to confirm it. **Stop.**
2. Grep `docs/PLAN.md` for the line `- [ ] $id ` or `- [x] $id ` (the id followed by a space, so `2.1` never matches `2.14`).
   - No match: say so, list the ids of the phase the user probably meant, and **stop**. Post-MVP phases (4b and later) have no task ids; they need a scoping pass first (PLAN §10).
   - Ticked (`[x]`): say the task is done and point to `/phase-status`. **Stop.**
3. Earlier work: list any unchecked tasks that come before `$id` in the same phase, and any unchecked tasks in earlier phases. If there are any, say PLAN §14.1 is one task at a time and in order, note whether §14.4 (independent tasks, no shared files) could justify it, and **ask whether to proceed out of order. Stop** until the user answers.
4. Preconditions in the task text: if the task is conditional (for example 2.10 "Only if 1.4 chose the relay"), find the deciding ADR in `docs/decisions/`. If the condition is unmet or undecided, say so and **stop**.

## 2. Branch

Decide the branch type from the task: `feat` (new behavior or code), `fix` (a bug fix), `test` (tests or evals only, such as 2.15 and 2.16), `docs` (docs only, such as 1.6), `chore` (tooling, config, scaffolding). The same type becomes the commit type in `/finish-task`. Proposed name: `<type>/<id>-<slug>`, where the slug is 2–4 kebab-case words from the task title (for example `feat/2.7-hook-ingest-event-store`).

- **Dirty tree** (any line in the status above): list the files and **stop**. Ask the user to commit, stash or discard them; never do it yourself. Other sessions may be editing this tree.
- **Current branch already contains `$id` as a token** (for example `feat/2.7-hook-ingest`): keep it and continue.
- **On `main`, or another branch:** propose the name above.
  - If the **user's own message** included `--branch` (use the proposed name) or `--branch=<name>` (use that name, after checking it has the form `<type>/<id>-<slug>`), create it now from `main`: `git switch -c <name> main`. Don't treat a flag you supplied yourself as consent.
  - Otherwise don't create it. Continue read-only with steps 3 and 4 and ask for the branch together with the plan approval in step 5.
- If the last commit of `main` differs from `origin/main` (`git log --oneline -1 main` vs `git log --oneline -1 origin/main`), tell the user; you don't fetch or pull.

## 3. Brief

Read each source; quote the task and criteria verbatim, and summarize everything else in one line per item.

1. **Task:** the full `$id` line from PLAN §10, verbatim.
2. **Phase:** the phase heading, its **Goal**, and its **Done when** line, verbatim.
3. **References:** every `§N.M` section, `D<n>` decision (→ `docs/decisions/00<nn>-*.md`), ADR number, file path and reviewer rule ID named in the task text. Read each; one line on what it requires of this task.
4. **Package rules:** read the `CLAUDE.md` of every package the task will touch (`packages/shared`, `packages/hook-relay`, `apps/server`, `apps/web`). For harness work (`.claude/`, `evals/`) read `docs/dev-harness.md` and `evals/harness/README.md` instead. List which ones apply.
5. **Reviewer eval cases due:** every entry in `evals/harness/reviewer/uncovered.json` whose `due` is exactly `$id`. For each: rule ID, its `why`, and its row from the catalog in `.claude/agents/reviewer.md`. These need a planted case in this task's PR, and the entry is removed from `uncovered.json` in the same PR (see "Adding a case" in `evals/harness/README.md`). Once the checkbox is ticked, `coverage.test.ts` fails CI for any that are left. Also flag any entry whose `due` task is already ticked (**overdue**; CI should already be red).
6. **Scheduled standards:** rows of `docs/engineering-standards.md` whose Status is `Scheduled:` with `$id` in its list. The task isn't done until each check exists; `/finish-task` flips the status.
7. **Threat model:** rows of `docs/security/threat-model.md` with status `planned: task $id`.

## 4. Plan

Write the plan in this order. If the PLAN text is wrong or ambiguous, say so and propose the PLAN edit instead of guessing (CLAUDE.md).

1. **Scope:** one sentence. **Out of scope:** later tasks this could drift into (by id).
2. **Files:** each path to create or change, with one line on why. Nothing outside the task.
3. **Tests:** whether the task touches code or tests and so needs the independent test writer (step 6; the definition is in `docs/dev-harness.md`, "Which tasks get locked tests"), the fixtures that exist for it, and any test infrastructure it needs first (a test dependency the task names, fixtures it delivers). **Don't design the tests here**: the test writer derives them from the task text and the acceptance clauses in item 6, never from this plan (ADR 0028).
4. **Eval cases:** for each rule from 3.5, a case directory name, the planted violation, and its `mustNotFind` neighbors.
5. **Docs:** standards rows, threat-model rows, protocol docs, ADR (only if a PLAN §2 decision changes).
6. **Acceptance checklist:** split the task text into atomic clauses, each testable or marked manual-verify. They are the test writer's and the reviewer's only statement of the task besides its text, so write them from the task, not from your plan. One checkbox per clause. Then add `npm run check`, `npm run test:coverage` (if `apps/`, `packages/`, `.claude/hooks/` or `evals/` change), the eval cases, and `/finish-task`.
7. **Commit:** the proposed Conventional Commit subject, for example `feat(server): add hook ingest and event store (2.7)`.
8. **Risks and questions:** anything you need the user to decide.

## 5. Stop for approval

End the turn with the output below. Stop here even for a task that touches two files or fewer; then the plan can be a few lines. After the user approves: create the branch first if it's still pending, run step 6 if the task changes code, then implement the plan, and tell the user to run `/finish-task` when done. If the user changes the plan, update it and ask again.

## 6. Tests first, by the test writer, then locked (after approval)

For a task that touches code or tests (ADR 0028; the definition is in `docs/dev-harness.md`, "Which tasks get locked tests"). `/run-phase` runs this step too.

0. **Test infrastructure first**, only if needed: commit on its own, before the test writer runs, what the tests need but don't define: a test dependency the task names (installed at its current version), the fixtures or other data this task delivers that its replay tests read, or a behavior-free seam (a type or interface, no logic). Subject `chore(<scope>): test infrastructure for <id>`, with a `Test-infra: <id>` trailer so `/finish-task` puts it in the reviewer's diff. Nothing that implements the task goes in it; the reviewer checks this (`TEST-lock`).
1. Invoke the `test-writer` subagent (never a fork: it must not inherit this conversation). Its prompt is exactly: the task id, the task line from PLAN verbatim, the acceptance clauses from step 4.6, and the phase's rules if it has a "Before you start" block. Nothing else: no plan, no file list, no hints about the implementation.
2. When it returns, check `git status --short`: only test paths (`*.test.ts`, `*.test.tsx`, `*.test-helpers.ts(x)`, `__snapshots__/`, `fixtures/`, `e2e/`) may be new or changed. Anything else: **stop** and report it; don't commit it.
3. Run the new tests (`npx vitest run <files>`) and confirm they fail as the test writer reported, apart from the ones it says guard existing behavior.
4. Commit its files **unchanged**, alone: subject `test(<scope>): failing tests for <what> (<id>)`, body with the clause-to-test table from its report and the sha of the step 6.0 commit if there was one, then the trailers `Test-lock: <id>` and the co-author line. Use `git add -- <paths>` and `git commit -F <file outside the tree>`.
5. `npm run tests:locked -- <id>` must pass. From here on, never edit, add or delete a test path for this task.
6. **A disputed test.** If, while implementing, you believe a locked test is wrong, don't touch it. A revision is only for the open unit (never after another task's lock), and only from a clean lock: `npm run tests:locked -- <id>` must pass first, so no edit of yours can ride along in the revision. The script also compares the state just before the revision with the original lock (`LOCK ... before revision`, `late-revision`). Invoke a fresh `test-writer` in revision mode with the task text, the clauses, the test and your objection in one paragraph. Commit whatever it changes as a second lock commit, with an extra `Revision-reason: <one line>` trailer. The lock script refuses a third lock commit: a second dispute **stops** the task for the user.

```
## Task $id: <title>
Branch: <current> (created | proposed: feat/<id>-<slug> — reply "yes" to create it)

### Brief
<step 3 items 1–7, one short block each; "none" where empty>

### Plan
<step 4 items 1–8>

**Approve this plan (and the branch)?**
```
