# Backlog

Review findings triaged as "later" (ADR 0031): already present before the change that surfaced
them, or belonging to a later task. `/start-task` lists the items that touch a task; the reviewer
reads this file so it doesn't report them as new. Remove an item in the change that resolves it.

| Item | Source | Where it belongs |
|---|---|---|
| For a `.cmd`/`.bat` binary (registry kind `cmd`), run the shim's real target or refuse to start; never pass arguments through cmd.exe | 2.3 security review | Task 2.6 (threat model, "Injection via repo path, name or first prompt") |
| Confirm with real Claude that `--` before the first prompt ends its options, so a prompt starting with `-` isn't read as a flag | 2.4 | Manual check in Phase 2's "Done when" run with real Claude |
| The registry passes an adapter's own `ts` and `id` at runtime (the conformance suite enforces them in tests); consider stamping them from the context | 2.3 review | Task 2.7 (ingest) |
| `tool.name`, `agentId`, `parentAgentId`, `tool.useId` and `usage.model` are neither scrubbed nor capped (hard rule 8 covers `text`, `tool.summary` and `raw`); consider a length cap in the registry | 2.3 security review | Task 2.7 (ingest; the body limit bounds them meanwhile) |
| `scrubRaw()` scrubs an object reachable along several paths once per path (exponential for a shared-reference DAG); not reachable from `JSON.parse` input | 2.2-fix3 review | Only if in-process values ever reach `scrubRaw()` |
| Scrubber: Sourcegraph `sgp_local_` and Lob `live_pub_`/`test_pub_` keys have no known-prefix pattern | 2.2-fix3 review | Scrubber corpus, when next touched |
| Scrubber: a CI run on macOS once drew a Twilio-shaped key (`SK` + 32 hex) whose hex survived; not reproduced in 26,000 runs of that shape since (the properties are seeded now) | CI, 2.4 push | Scrubber, if it recurs |
| Scrubber: the seed sweep found 40-character mixed-case letter-only tokens that pass as words (`digitFreeToken(-1578093748, 40, LETTERS)` and `digitFreeToken(140643653, 40, LETTERS + '-_')` in `scrub.test-helpers.ts`; fast-check seed 444464). Within the accepted "pronounceable mixed-case" gap; add them as rows if `wordLike` is ever tightened | Consolidation seed sweep | Scrubber, when next touched |
| Before deleting `spikes/phase-1/` at the end of Phase 2 (PLAN schedules it): move the capture sink and fixture scrubber somewhere permanent for the `record-fixture` skill (StopFailure and `elicitation_dialog` still need recording), and move the `.md` evidence the ADRs and the protocol doc cite into `docs/protocols/` | Consolidation (ADR 0031) | Phase 2 end |
| Conformance suite: after the trim to 18 broken adapters, some rules in `conformance.test-helpers.ts` have none that trips them (events: `provider`, `sessionId`, ids from `ctx.newId`, the root agent id, `v`; facts-only: mood, attention; launch: the token in a file name, env pointing into the worktree, absolute or separator file names, non-string args or env, a throwing `launch`). Add one broken adapter per rule | Consolidation review | Before the Phase 5 adapters rely on the suite |
| Guard hook: a `node -e` one-liner was denied by the `.env` rule (a false positive; the exact command wasn't kept). Reproduce it with `decide()` and add a table row when it recurs | Consolidation (ADR 0031) | Harness, when it recurs |
| The `statusline-*` fixtures have no consumer (the status line isn't used, D30), while Phase 2's "Done when" asks for a replay test per fixture | 2.4 | Phase 2 end: delete them or mark them as reference |
