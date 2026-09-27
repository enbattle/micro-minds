# 0027. Claude pushes task and phase branches; merges stay human

- Status: Accepted
- Date: 2026-09-27
- Plan: D27 (PLAN §2)

## Context

Phase 0 denied `git push` to Claude entirely (task 0.5), so every task ended with the user
copying a push command, a `gh pr create` command and a merge command. In Phases 0 and 1 that
hand-off was most of the user's time per task, and it came once per task: 8 times in Phase 1 and
16 in Phase 2.

The server side already protects `main` on its own. The `protect-main` and `ci-verify` rulesets
have no bypass actors. They require a pull request, the `check` job on three operating systems,
the `commits` lint and CodeQL, and they block force-pushes and deleting `main`. A push to any
other branch can't change `main`.

The one step nothing automated can replace is the merge. It's the only point where a human looks
at the change: the reviewer is a model too, so without it an AI would approve its own work. This
matches common practice: coding agents (GitHub's Copilot coding agent, Codex, Claude Code in
GitHub Actions) push to their own branches and open pull requests, and a human merges. Claude
Code's auto-mode classifier also refuses `gh pr merge` as a merge without review.

The goal until the MVP ships (end of Phase 4a) is to get to a usable app quickly, so real use
produces feedback. Nobody depends on the app yet, so the caution that matters once it's in use
(a small, separately merged change at a time) buys little now. The quality bar stays the same:
the speed comes from fewer human round-trips, not from skipping gates.

Options considered:

1. Keep the blanket deny. Safe, but it keeps the hand-off cost per task.
2. Allow push and merge. Removes the only human checkpoint. Rejected (see
   [deferred-practices.md](../deferred-practices.md)).
3. Allow push to task and phase branches, keep merge human, and let one user-started run cover a
   whole phase. Chosen.

## Decision

- `.claude/settings.json` allows `git push [-u] origin <prefix>/*` for the branch prefixes
  `feat`, `fix`, `docs`, `test`, `chore` and `phase`, plus `gh pr create|edit|ready|view|checks|list`
  and `gh run view`. It denies force-pushes (`--force*`, `-f`, `+refspec`), deletes (`-d`,
  `--delete`, `:branch`), `--mirror`, `--all`, `--tags`, any push naming `main`, and `gh pr merge`.
  Because `*` in a rule also matches spaces, it also denies more than one ref after `origin` and
  any `src:dst` refspec, so an allowed push is exactly one task or phase branch. Deny rules win
  over allow rules. `evals/harness/integrity/integrity.test.ts` checks the real settings against a
  table of allowed, denied and prompted commands.
- `/finish-task` pushes the branch, opens the pull request (a draft on a phase branch) and waits
  for CI. It never merges. It ends with the merge command for the user.
- `/run-phase <n>` (user-invoked) runs every remaining task of a phase in order on one branch,
  `phase/<n>-<slug>`: one reviewed commit per task, one pull request per phase. Starting it is the
  user's approval for that phase's per-task plans, commits and pushes, and for the phase's
  token-spending eval runs. It stops for anything only the user can do or decide (Phase 1
  recordings, manual checks, PLAN changes) and never merges.
- **Which mode when:** `/run-phase` is the default through the MVP (Phases 1–4a). After it ships,
  per-task pull requests (`/start-task` + `/finish-task`) become the default again, because
  changes then land in an app people use.
- Every per-task gate still applies inside a phase run: tests first where required,
  `npm run check`, coverage, due eval cases, a reviewer pass, the PLAN tick and the phase gate.
- Claude can't change its own permissions: the `settings.json` change is applied by the user.

## Consequences

### Positive

- The user's per-phase work shrinks to the human steps the plan requires and one merge.
- Each task commit still gets the full `/finish-task` gates, and CI runs on every push (the draft
  pull request exists from the first task).
- Merge commits keep one commit per task in `main`'s history (engineering standards, "Merge
  commits, not squash").

### Negative

- Claude's pushes are published to GitHub straight away. The data to protect is Phase 1's raw
  captures: they stay outside the repo and are gitignored, `/finish-task` refuses untracked or
  unstaged files, and GitHub secret scanning with push protection is the backstop.
- A phase pull request is large (Phase 2 has 16 tasks). Mitigations: one commit per task with
  its reviewer verdict in the pull request body, so it can be read commit by commit; CI on every
  task.
- Tasks inside a phase run without per-task plan approval. Mitigations: the stop conditions in
  `/run-phase` (ambiguous PLAN text, ADR-level decisions, repeated gate failures), and the user
  reviews before the merge.
- Permission patterns are prefix and glob matches, not a parser: an unusual push form can fall
  through to a prompt. The server-side rulesets remain the real protection for `main`.

## Revisit when

- The MVP ships (Phase 4a is complete): switch the default back to per-task pull requests.
- The repo gains a second human reviewer or required approvals (then merge policy can be
  reconsidered).
- A push from Claude publishes something it shouldn't have, or a phase pull request proves too
  large to review (then split phases into several pull requests).

## References

- PLAN §2 D27, §10 (task 0.5), §14
- `.claude/skills/finish-task/SKILL.md`, `.claude/skills/run-phase/SKILL.md`
- [docs/dev-harness.md](../dev-harness.md#task-workflow), [docs/engineering-standards.md](../engineering-standards.md)
