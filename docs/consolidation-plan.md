# Consolidation plan

How [ADR 0031](decisions/0031-proportionate-review-and-evals.md) was applied to the repository as
it stood after Phase 2's first four tasks (pull request #13). It ran once, on its own branch,
before task 2.5. Every step kept behavior: `npm run check` and `npm run test:coverage` stayed
green, and the scrubber's coverage is unchanged (96.9% statements, 98.41% lines).

Approving this plan was also the user's approval for its one-off edits to locked test files
(merging, deduplicating and seeding them). The test lock applies as before from here on.

## 1. Process (ADR 0031)

- [x] ADR 0031 accepted; D28 in PLAN §2, ADR 0028's status and the ADR index point at it.
- [x] `.claude/agents/reviewer.md`: told where the repository's settled decisions live (accepted
      risks, `docs/backlog.md`, ADRs) so it doesn't re-report them; runs the security checks in
      the same review with `security: yes`. The adversarial mandate, `probed` and `introduced`
      stay.
- [x] `.claude/agents/test-writer.md`: a required `## Interpretations` section, lean tests, seeded
      properties, follow-up tests in the existing file, written-out end states instead of snapshots.
- [x] `/finish-task`: one review with security checks where due, then the triage table (fix,
      backlog, reject, the user decides) in the pull request body; a second round only if a fix
      changed behavior beyond its finding.
- [x] `/start-task`: the brief lists related backlog items; the test writer's interpretations are
      checked before locking; follow-up tests go into the existing test file.
- [x] `/run-phase`: the same loop; the completeness audit's gaps are triaged like findings, and
      fix units are gone.
- [x] `docs/backlog.md` created and seeded (section 6).

## 2. Evals

- [x] All 32 reviewer cases and the phase gate (`--trials 3`) kept.
- [x] `evals/harness/reviewer/uncovered.json` is a plain list (rule → why no case yet); its due dates
      and the schedule check are gone. `coverage.test.ts` still checks every catalog rule is
      covered by a case or listed.
- [x] `evals/harness/README.md`: the schedule is replaced by the triggers (a real miss, a confirmed
      false positive, a new rule).
- [x] False positives are reported next to recall (the runner already printed both).
- [x] The session-context hook and `/phase-status` no longer list "rules due"; `/phase-status`
      lists backlog items for the next task.

## 3. Tests

- [x] **Scrubber tests**: 9 files (3,694 lines) became 4 (3,033 lines): `scrub.test.ts` (the
      corpus), `scrub.property.test.ts`, `scrub.performance.test.ts` and `scrub.test-helpers.ts`.
      Duplicates of the same behavior on the same input shape were dropped; every distinct shape,
      regression case and guard stayed, and several rows now assert exact output. The mapping from
      old tests to new is in the pull request.
- [x] **Every property test is seeded** (15 in the scrubber, 4 in the reducer; the registry's was
      already). A seed sweep found no new failure class: two 40-character mixed-case letter-only
      tokens pass as words, inside the accepted "pronounceable" gap, so they went to the backlog.
      The Twilio-shaped CI failure didn't reproduce in 6,000 more runs.
- [x] **Conformance suite**: 41 broken adapters became 18, one or two per check.
- [x] **Missing tests added**: scrub before truncation in `oneLine()` (secrets straddling the 120-
      and 200-character cuts, emoji at the cut); the registry's `normalize()` with a revoked Proxy,
      a throwing `length` and a `clock.tick`; quoted Windows PATH entries and skipped script
      extensions in `resolveBinary()`.
- [x] **Proof nothing was lost**: the mapping table, checked once by a fresh reviewer; coverage
      didn't drop. The suite went from 2,826 to 2,526 tests.

## 4. Docs and harness

- [~] One source per rule: the review loop, eval schedule and triage are now stated once (the
      skills and ADR 0031) and referenced from CLAUDE.md, `docs/dev-harness.md`, the glossary and
      the standards. A deeper rewrite of the skills into short checklists is not done: they are
      procedures with gates, and shortening them risks dropping a gate.
- [x] `docs/security/threat-model.md`: the "Scrubbing is heuristic" note is a short list of known
      gaps by kind (token shapes, where secrets sit, the code exemption, key names, cost).
- [x] `docs/engineering-standards.md`: rows for the review loop, triage, eval accounting and seeded
      properties.
- [x] Guard hook: the broad rules stay (a home reference anywhere plus a relative config-dir path;
      any word that looks like a recursion flag, anywhere). Two review rounds showed that every
      narrowing of those rules opened bypasses (`$(…)`, variables, .NET calls, wrapped native
      tools), so the only narrowing left is an explicit list of PowerShell parameters that can't
      mean recursion (`-Pattern`, `-First`, `-Raw`, …). `-s`, `-Depth` and `-Recurse:$true` now
      count as recursion. A differential check against the previous guard over 86 commands found no
      command it denied that this one allows, apart from those parameters. The `~`-in-text false
      positive is an accepted cost, listed in the backlog's "Harness friction". 37 new table rows.
- [x] ~~Delete `spikes/phase-1/` now.~~ Kept, after checking it against the repository: its sink
      and `spike:scrub` are the only fixture-recording and scrubbing tools, fixtures are still
      needed (StopFailure, `elicitation_dialog`), and its `.md` files are the evidence ADRs 0029
      and 0030 and `docs/protocols/claude.md` cite. It stays on PLAN's schedule (end of Phase 2),
      with a backlog item to move the recorder, the scrubber and the evidence first.

## 5. How to verify

- `npm run check`, `npm run test:coverage` and `npm run lint:commits` green, CI green on all three
  platforms.
- The test mapping table reviewed once (section 3).
- The phase gate (`npm run eval:harness -- --trials 3`) runs at the end of Phase 2 as usual; this
  change doesn't alter the reviewer's catalog or cases.

## 6. Backlog

Seeded into [backlog.md](backlog.md) from the Phase 2 reviews and this consolidation.

## Out of scope

- No product behavior changes, no new features, no PLAN task work.
- No change to the hard rules, the test lock itself or CI.
