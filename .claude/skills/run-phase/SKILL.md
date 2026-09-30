---
name: run-phase
description: Run every remaining task of one micro-minds PLAN phase in order on a single phase branch - brief and plan each task (start-task steps), have a fresh test-writer write and lock its failing tests, implement it, finish it with the finish-task gates (one independent adversarial review with security checks where due, findings triaged), push, and keep one draft pull request for the phase with CI on every task. Stops only for steps the user must do or decide, then ends with a completeness audit, the phase gate, a report and the merge command. Never merges. User-invoked only; takes the phase id (1, 2, 3, 4a).
argument-hint: <phase>
arguments: [phase]
disable-model-invocation: true
allowed-tools: Read Grep Glob Edit Write Bash(git add *) Bash(git commit *) Bash(git switch -c *) PowerShell(git add *) PowerShell(git commit *) PowerShell(git switch -c *)
---

# Run phase `$phase`

Starting this skill is the user's approval, for this phase only, of: each task's plan without a per-task approval stop, a test commit and an implementation commit per task, pushes to the phase branch, a draft pull request, and the phase's token-spending eval runs (`--run-evals`: eval cases a trigger adds, and the phase gate). It is **not** approval to merge, to change a PLAN §2 decision or a hard rule, or to do anything the phase's own rules reserve for the user. The policy is ADR 0027 (pushing and merging), ADR 0028 (tests and review) and ADR 0031 (triage, one round, evals from real misses); PLAN §14 still applies (one task at a time, in order).

## Git state (captured before you read this)

Current branch:
!`git branch --show-current`

Uncommitted changes (`git status --short`; nothing listed means clean):
!`git status --short`

## 0. Set up

1. **Phase:** `$phase` must match a `### Phase $phase:` heading in `docs/PLAN.md` that has task checkboxes. Post-MVP phases have none (they need a scoping pass): **stop**.
2. **Order:** every task of every earlier phase is ticked, and the earlier phase's gate was recorded. Otherwise list what's open and **stop**.
3. **Nothing left:** if every task of the phase is ticked, go to step 3.
4. **Branch:**
   - Dirty tree: list the files and **stop** (never stash, reset or discard).
   - On `phase/$phase-<slug>`: resume on it. Check `git log --oneline origin/main..HEAD` against the ticked tasks so you know where you are.
   - On `main`: `git log --oneline -1 main` must equal `git log --oneline -1 origin/main` (otherwise tell the user and **stop**). Create `phase/$phase-<slug>` from `main` (`git switch -c`), with a 2–4 word kebab-case slug from the phase title.
   - Any other branch: **stop** and ask.
5. **Read once:** the phase's **Goal**, its "Before you start" block if it has one, and its **Done when**. They bind every task below.

## 1. Loop: each unticked task, in order

For task `<id>`:

1. **Brief and plan.** Read `.claude/skills/start-task/SKILL.md` and follow its steps 1.2–1.4, 3 and 4 for `<id>`. Don't invoke it with the Skill tool: its tool restrictions would block editing for the rest of the turn. From its step 2, skip the branch handling (you're on the phase branch) but still decide the task's type with its rule: that type becomes the commit type in `/finish-task` step 7.2. Skip its step 5 (no approval stop). Write the plan down in a few lines before coding, so the reasoning is in the transcript.
2. **Check the stop conditions** (step 2) against the plan. If one applies, stop now, before writing code.
3. **Tests first, by the test writer, then locked:** for a code task, follow `.claude/skills/start-task/SKILL.md` step 6 (a fresh `test-writer` gets only the task text and the acceptance clauses; you commit its files unchanged with a `Test-lock: <id>` trailer). Use `--base origin/main` with `npm run tests:locked` on the phase branch.
4. **Implement** against the locked tests, never editing one. Stay inside the task: later tasks are out of scope even when they're adjacent.
5. **Finish.** Read `.claude/skills/finish-task/SKILL.md` and follow it with id `<id>`, `--run-evals`, in phase-branch mode. It gates, commits, pushes, creates or updates the draft pull request, and waits for CI. Any **stop** in it stops this run too.
6. **Log one line** to the user (`<id> done: <sha> <subject>, CI green`) and continue with the next task. Don't wait for an answer.

## 2. Stop conditions

Stop the run, leave the tree clean (commit only finished tasks), and report where you stopped, why, and exactly what the user needs to do. The next `/run-phase $phase` resumes from the first unticked task.

- **A human step.** The task text or the phase's rules say the user does it (for example Phase 1's recorded scenarios, which the user runs), or it needs a manual check only a person can make (login, visual rendering), or it spends tokens outside the eval runs (such as headless `claude -p` recordings). First prepare everything the user needs, so their step is one command or one action, and say how to resume.
- **A decision that's the user's.** The PLAN text is wrong, ambiguous or contradicts itself; the task would change a PLAN §2 decision, a hard rule or CLAUDE.md; a dependency or tool choice needs an ADR the plan doesn't already settle; or the task's preconditions (for example a task marked "Only if …") are unmet.
- **Gates that won't pass.** Anything `/finish-task` stops on: a check, coverage or CI failure you can't fix within the task, a broken test lock, blockers left after a second review round, a reviewer that changed the repository, a blocker you would reject or defer, or a test-writer interpretation that contradicts the repository.
- **A second test dispute.** You believe a locked test is wrong after its one revision (`/start-task` step 6.6).
- **Anything outside this approval.** Merging, force-pushing, deleting branches, worktrees or files you didn't create, touching global config, or anything else the harness denies. Don't look for another route.

Don't skip ahead to later tasks while one is blocked: PLAN §14.1 is in order.

## 3. Phase end

When the last task is ticked, `/finish-task` step 5.2 has already run the phase gate. Then:

1. **Completeness audit** (ADR 0028). Each review checked one task; nothing yet checked that the whole phase was carried out. Invoke a fresh `general-purpose` agent (never a fork) with only: the phase's section of `docs/PLAN.md` (heading to the next phase heading), and the instruction to run `git diff origin/main...HEAD` and read what it needs. Nothing from this conversation. Ask it to return a table with one row per task clause and per **Done when** clause: the clause, the evidence (file and line, test name, or commit), and a status of implemented, deliberately changed (with whether the stated reason holds), partial, or missing. It must not edit anything; snapshot the repository around it as in `/finish-task` step 4.1.
2. **Partial or missing rows:** triage them as review findings are triaged (`/finish-task` step 4.5). A missing clause of this phase is a **fix**: make it as one follow-up with the id `<id>-fix` (never by reopening the task), with its tests from a fresh `test-writer` added to the existing test file (`/start-task` step 6.7), then `/finish-task` steps 0.4–4, 7 and 8 in phase-branch mode, with BASE the parent of its first `Test-infra: <id>-fix` or `Test-lock: <id>-fix` commit (or `HEAD` for docs only) and the subject `fix(<scope>): <what> (<id>)`. No PLAN tick. Anything else is **backlog** or **user**, as in triage. Every follow-up is pushed and green before step 4 below.
3. Append to the pull request body: `## Completeness audit` (the table), `## Phase gate` (the baseline row and the eval result) and `## Done when`, with each clause of the phase's **Done when** marked met, unmet or needs manual check, with evidence.
4. If every clause is met or only needs a manual check: `gh pr ready <branch>`, then `gh pr checks <branch> --watch` (gate on the exit code).
5. Report, and **stop**:

```
## Phase <n> ready: <phase title>

| Task | Tests locked | Commit | Review | Triage | CI |
|---|---|---|---|---|---|
| <id> | <sha or n/a> | <sha> <subject> | <verdict>, <n> round(s), security <yes/no> | <k> fixed, <b> backlog, <r> rejected | green |

Completeness audit: <n> implemented, <deviations>, <partial/missing> · Phase gate: <pass, baseline row> · Done when: <met / unmet clauses> · Eval spend this phase: <runs>
Manual checks left for you: <list, or "none">

Pull request: #<number> <url>
Review it (commit by commit works: each task is its locked test commit, then its implementation commit), then merge it yourself:

gh pr merge <number> --merge --delete-branch
```

Never merge, and don't start the next phase: that starts with the user's next `/run-phase`.
