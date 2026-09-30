# /finish-task templates

Read at step 8 of `SKILL.md`, not before. Kept out of the skill so they aren't in context for the
whole task.

## Task pull request body

Ends with the PR attribution line your harness instructions give, if any.

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

## Phase pull request body

A `## Phase <n>: <title>` heading with the phase's **Goal**, then one section per task, appended as
each task finishes. `/run-phase` adds the phase gate and "Done when" sections at the end.

```markdown
### <id> `<sha>` <subject>
- <what changed, one bullet per area>
- Checks: check pass; tests locked in <sha> (or not a code task); coverage <pass / not needed>; eval cases <cases / none triggered>; review <verdict>, <n> round(s), security checks <yes/no>
- Triage: <finding → outcome (evidence), one line each, or "no findings">
- Probed: <the reviewer's probed list, condensed>
- Manual: <checks the user still has to do, or "none">
```

## Final report (task branch only)

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
