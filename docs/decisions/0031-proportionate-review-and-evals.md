# 0031. Proportionate review: triage findings, one round, evals from real misses

- Status: Accepted
- Date: 2026-09-29
- Plan: D28 (PLAN §2), amends ADR 0028; touches ADR 0027's `/run-phase` loop

## Context

Phase 2's first four tasks ran the full ADR 0028 loop: a test writer, locked tests, an adversarial
reviewer, a security pass, up to three rounds, fix units with their own locked tests, and a planted
reviewer eval case for every rule due with the task. It worked: review caught real bugs that tests
missed. Examples: one session's events changing another's agents (2.1), a ReDoS (2.2), a `.cmd`
shim running the first prompt through cmd.exe (2.3), and truncation before scrubbing that leaked
secrets (2.4). Almost every one of them came from a task's first review round.

The cost came from what followed. Task 2.2 grew three fix units and about a dozen review runs, most
of them re-finding gaps the threat model already accepts for a heuristic scrubber. 2.3 took three
security rounds whose findings were the wording of a comment meant for task 2.6. Test files
multiplied: the scrubber has nine test files, about 3,400 lines for about 500 lines of code,
because every fix unit needed a new locked file. Across the repository, support code outweighs
product code about ten to one, and the process skills are loaded into context for every task.

The loop has no triage step. ADR 0028 already says only findings a change introduced block, but
every finding still went straight to "fix it". The reviewer is independent on purpose: it sees
artifacts, not the implementer's claims. The price is that it doesn't know what the repository
already decided (accepted risks, known gaps, later tasks), so its findings need checking against
the repository before anyone acts on them. Other teams do this too: code review separates blocking
from non-blocking and lets the author push back, security programs triage every report for
validity, severity and duplicates before fixing, and AI evaluation measures a judge's false
positives as well as its misses.

## Decision

Everything ADR 0028 adopted stays: tests first by a separate writer, the test lock, an independent
adversarial reviewer with artifact-only input, a security pass where the threat model says so, and
evals. What changes is how much of it runs, and what happens to findings.

1. **Triage every finding before fixing it.** The implementer sorts each finding into one of four
   outcomes, with evidence:
   - **Fix**: reproduced (or plainly true from the code), introduced by this change, and in scope.
   - **Backlog**: present before the change (the reviewer's own `introduced: false`) or belonging
     to a later task. It goes to `docs/backlog.md` with the finding and its source.
   - **Reject**: contradicts an accepted risk, an ADR or a PLAN decision. The triage cites it.
   - **Needs the user**: a blocker the implementer wants to reject or defer, or a disagreement
     about scope. The run stops for the user, as for any stop condition.
   The triage table goes into the pull request body, so every reject or defer can be audited and
   overruled. The user is the product owner who settles disputes.
2. **One review round per task**, with the standard and security checks in one run where a
   security pass is due. A second round only when a fix changed behavior beyond the finding it
   fixed. The user still decides after the second round.
3. **The reviewer gets the repository's context, not the implementer's.** Its prompt adds a
   pointer to the accepted risks (`docs/security/threat-model.md`, "Residual and accepted risks"), the backlog
   and the ADRs. These are repository documents, not claims about the change, so the review stays
   artifact-only.
4. **The test writer's interpretations are checked, not litigated.** Its report lists the
   assumptions it made where the clauses were silent. Before locking, the implementer checks them
   against the repository and raises real disagreements with the user in one line. The lock stays.
   The one-revision rule stays for disputes found after locking, but a follow-up change adds tests
   to an existing file under its own `Test-lock` instead of creating a new "fix" file.
5. **Evals grow from real misses, not from a schedule.** The 32 existing reviewer cases and the
   phase-gate run stay, so quality can't silently deteriorate. New cases come from:
   - a bug the reviewer missed that surfaced later (a planted case reproducing it);
   - a finding triage confirmed as a false positive (a clean case that must not raise it);
   - a new rule added to the reviewer's catalog.
   `evals/harness/reviewer/uncovered.json` stays as a plain list of rules with no case yet and
   the reason, so what isn't measured stays visible; its per-task due dates and the CI check that
   forced a case when a task was ticked go away. False positives (clean cases flagged,
   `mustNotFind` hits) are reported next to recall, as the runner already does.
6. **Property tests are seeded.** Every `fc.assert` passes a fixed seed. A random CI failure is a
   bug in the test setup; a counterexample found by a seed sweep becomes a fixture or a table row.
7. **Each rule lives in one place.** CLAUDE.md, the package `CLAUDE.md` files, the skills and the
   harness docs link to the rule's source instead of restating it. The skills become short
   checklists.

## Consequences

### Positive

- Review keeps finding what matters (the first round did) without rounds spent on settled
  questions. Tasks take fewer tokens and less time.
- Decisions not to fix something are written down, auditable and reversible by the user.
- Evals measure the reviewer on the failures that actually happened, including false positives.
- Fewer, larger test files with the same behaviors; no random CI failures from unseeded properties.

### Negative

- The implementer now judges findings against its own change, which is the bias ADR 0028 removed.
  Mitigations: triage needs evidence (a reproduction, or a cited document), the reviewer's own
  `introduced` flag drives the backlog outcome, every outcome is visible in the pull request, and
  a rejected blocker always goes to the user.
- One round can miss what a second would catch. Mitigation: the phase-end completeness audit and
  the eval triggers above, which turn a miss into a case the next reviewer is tested on.
- Rules without a planted case stay untested until a real miss. Mitigation: the existing cases
  cover every rule due so far, and the phase gate runs them all.

## Revisit when

- A bug reaches `main` that a second review round would have caught: restore it for the kind of
  task where it happened.
- Triage rejects a finding the user later overrules more than once in a phase: tighten the
  evidence rule.
- The eval recall on the phase gate drops below its threshold.

## References

- ADR 0028 (tests and review), ADR 0027 (pushing and merging), ADR 0014 (scrubbing)
- `docs/consolidation-plan.md` (how this is applied to the repository as it is)
- PLAN §11.1 (harness evals), §14 (working style)
