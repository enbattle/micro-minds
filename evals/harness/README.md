# Harness evals

The AI developer harness (`CLAUDE.md`, `.claude/agents/`, `.claude/skills/`, `.claude/hooks/`) is code, so it gets tested too (PLAN §11.1). There are two suites:

| Suite | What it checks | Deterministic | Runs in CI |
|---|---|---|---|
| **Guard evals** (`guard/`) | The `PreToolUse` guard hook allows and blocks a table of commands | yes | yes (`npm test`) |
| **Reviewer evals** (`reviewer/`) | The `reviewer` agent finds planted violations and stays quiet on clean code | no (calls the model) | **no**: costs tokens |

The reviewer suite also has deterministic parts that do run in CI through the `harness` Vitest project: `score.test.ts`, `invocation.test.ts`, `resolve-bin.test.ts`, `cases.test.ts`, which validates every case file against the agent's rule catalog, and `coverage.test.ts`, which checks every rule is covered by a case or listed with a reason (see [Growing the harness](#growing-the-harness)).

## Reviewer evals

Each case in `reviewer/cases/<case>/` has:

- `change.diff`: a realistic unified diff in this repo's layout. Most cases plant one violation (binding `0.0.0.0`, a hook token accepted on the WS, an adapter setting health, `raw` sent over the WS, `Date.now()` in `reduce()`, an unvalidated WS frame, reading `~/.claude`, `any` plus `enum` in shared, string path concatenation, auto-killing orphans). `crash-recovery-two-issues` plants two violations, and the `clean-*` cases plant none.
- `expected.json`:

  ```json
  {
    "mustFind": ["HR3-localhost-bind"],
    "mustNotFind": ["HR8-raw-leak"],
    "notes": "What is planted and why the mustNotFind rules must not fire."
  }
  ```

  Rule IDs come from the catalog tables in `.claude/agents/reviewer.md`. An empty `mustFind` makes the case **clean**.

### Scoring

- **Recall** = planted rule IDs reported ÷ planted rule IDs, over all cases, at any severity.
- **mustNotFind hit**: the reviewer reported a rule the case says doesn't apply (a false positive on a planted case).
- **Clean-case false positive**: any `blocker` or `major` finding on a clean case. `minor` findings are allowed.
- **Error**: the CLI failed, timed out, hit the turn or budget cap, or the final ```json block didn't parse. Its planted rules count as missed. A block without a non-empty `probed` list doesn't parse (ADR 0028: a review must show what it tried), so an approval that shows no work is an error, not a pass.

A **trial passes** only if it has no error, no missed planted rule, no mustNotFind hit and no clean-case blocker/major finding. With `--trials N`, a **case passes** when at least `requiredPasses(N) = ceil(2N/3)` of its trials pass: 1 of 1, 2 of 2, 2 of 3, 3 of 4, and so on (`reviewer/trials.ts`).

The run **fails** (exit 1) if any case misses its required pass count, if recall over all trials is below `RECALL_THRESHOLD` (0.8, in `reviewer/score.ts`), or if any trial errored. At `--trials 1` this means every case must pass, so a single miss fails the run. Use `--trials 3` to tell a real regression from run-to-run variation. Cases that passed some but not all trials are listed as **flaky** under the table. Verdict mismatches and rule IDs outside the catalog are reported but don't fail the run.

The header and the results JSON record the exact Claude Code version (`claude --version`) and the model IDs used (from `modelUsage` in the CLI's JSON output). At the end the runner prints a ready-to-paste row for the baseline history table.

### Running

```sh
npm run eval:harness                                  # all cases
npm run eval:harness -- bind-all-interfaces raw-over-ws   # selected cases
npm run eval:harness -- --dry-run                     # validate cases, print the command, spend nothing
npm run eval:harness -- --trials 3                    # each case 3 times; required for phase gates
npm run eval:harness -- --model opus --max-turns 8    # overrides; see --help
```

Prerequisites: Claude Code on `PATH`, logged in. The runner prints a summary table and writes the full report, including each raw review, to `reviewer/results/<timestamp>.json` (gitignored). When `CI` is set it prints why and exits 0 without doing anything.

How a case runs: from the repo root, the runner spawns

```
claude -p --agent reviewer --output-format json --permission-mode dontAsk --tools Read,Grep,Glob
       --max-turns 12 --max-budget-usd 1 --no-session-persistence --setting-sources project --strict-mcp-config
```

and writes the instructions and the diff to **stdin**. This avoids the Windows command-line length limit and all argument quoting. `claude` is found by a PATH/PATHEXT lookup in Node, not by `where` or `command -v`, so the same code runs on every OS without a shell. A native `claude.exe` is spawned directly. An npm `claude.cmd` shim needs `shell: true` on Windows, which is safe here because every argument is checked against a shell-safe pattern.

In a workspace that hasn't been trusted, `claude -p` warns that it ignores the `permissions.allow` entries in `.claude/settings.json`. That's harmless here: the reviewer only reads files inside the repo, which needs no allow rule under `dontAsk`.

### Cost

Each case is one headless reviewer session. Expect a few cents to about $0.30 per case, depending on the model and on how much of `CLAUDE.md` and `docs/PLAN.md` the reviewer reads. `--max-budget-usd` (default $1) caps each case. The report records `total_cost_usd` per case and in total.

### When to re-run

Re-run the whole suite, and compare with the previous report, whenever any of these change:

- `CLAUDE.md` or a package `CLAUDE.md`
- anything in `.claude/agents/` (especially the reviewer's rule catalog or output contract)
- PLAN §2 (decisions) or §9 (security)

Also re-run after a Claude Code upgrade or a model change. Results vary from run to run, so treat a single miss as a signal to look at the review, not as proof of a regression.

### Adding a case

1. Create `reviewer/cases/<kebab-name>/`. Clean cases start with `clean-`.
2. Write `change.diff` as a real unified diff with `a/`/`b/` paths as they would be in this repo (`git diff` output, LF line endings). Keep it small and otherwise correct, so the only defects are the planted ones. Put a plausible justification next to the violation so it takes a careful read to spot it. Clean cases should include their tests, and those tests must cover every branch the code adds (the first baseline caught an untested 429 path). A case may import relative helpers it doesn't include; the eval prompt tells the reviewer that the diff is an excerpt and that such modules exist (`buildPrompt` in `reviewer/invocation.ts`).
3. Write `expected.json`. `mustFind` lists every planted rule ID. `mustNotFind` lists nearby rules the code deliberately satisfies (for example `SEC-token-compare` when the code does use `timingSafeEqual`). `notes` explains both.
4. If a new rule ID is needed, add it to a catalog table in `.claude/agents/reviewer.md` first. If the case covers a rule listed in `reviewer/uncovered.json`, remove that entry in the same PR (CI fails on stale entries). Add a case for one of the triggers below, not per task.
5. Run `npm run eval:harness -- --dry-run` and `npx vitest run --project harness`, then run the new case for real: `npm run eval:harness -- <kebab-name>`.

## Growing the harness

The harness is expected to grow with the codebase. Growth is driven by the events below, and the
deterministic parts are enforced in CI rather than left to memory
([docs/dev-harness.md](../../docs/dev-harness.md), principle 1).

### Coverage accounting (enforced)

Cases come from real events, not from a schedule (ADR 0031): the triggers below. Every rule ID in
the reviewer's catalog is either exercised by a case's `mustFind` or listed in
[`reviewer/uncovered.json`](reviewer/uncovered.json) with the reason it has no case yet, so what
isn't measured stays visible:

```json
"SEC-token-compare": "No miss or false positive yet. First code it governs: task 2.7 (HookIngest validates hook tokens)."
```

`coverage.test.ts` fails CI when a rule has neither a case nor an entry (for example, a new rule
added to the catalog), when an entry names a rule that isn't in the catalog, or when an entry is
stale because a case now covers it. The run summary reports misses (recall) and false positives
(clean cases flagged, `mustNotFind` hits) side by side.

### Triggers

| Event | Required harness change |
|---|---|
| A new hard rule or reviewer rule ID | A planted case in the same PR, or an `uncovered.json` entry saying why not yet (the test enforces one or the other) |
| The reviewer misses a real problem (found later in a PR, in CI or in use) | A regression case made from that diff, trimmed and sanitized |
| The reviewer flags good code (a real false positive, confirmed in `/finish-task` triage) | A clean case, or a `mustNotFind` entry on the closest case |
| The guard is bypassed or over-blocks | A new row in `guard/guard.test.ts` (runs in CI) |
| A reviewer model or Claude Code upgrade | A full run with `--trials 3` and a new baseline row |
| A change to `CLAUDE.md`, `.claude/agents/`, PLAN §2 or §9 | A full run and a new baseline row |

### Phase gate

Before a phase is marked complete (docs/PLAN.md §14):

1. Run `npm run eval:harness -- --trials 3`. Every case must pass at least 2 of 3 trials, and
   overall recall must stay at or above the threshold.
2. Add a row to the baseline history below, with the exact model ID and Claude Code version the
   runner prints.
3. Any false positive triage confirmed during the phase has its clean case or `mustNotFind` entry.
4. Ten minutes on the "Harness friction" list in `docs/backlog.md`: each entry becomes a fix, an
   eval case, an accepted cost, or stays.

## Baseline history

Record each full run that follows a change to `CLAUDE.md`, `.claude/agents/` or PLAN §9, so regressions are visible.

| Date | Reviewer model | Recall | Clean-case false positives | Forbidden hits | Cost | Notes |
|---|---|---|---|---|---|---|
| 2026-09-27 | default (inherit) | 12/12 (100%) | 0 | 1 → 0 | ≈ $0.94 + $0.10 | The first run flagged `TEST-missing` (minor) on `clean-hook-ingest`. The reviewer was right: the case's tests never exercised the 429 rate-limit path. Fixed the case by adding a per-session rate-limit test; the re-run passed. |
| 2026-09-27 | claude-opus-5-5 | 36/36 (100%) | 1 | 0 | ≈ $1.79 | CC 2.1.283; trials 3; PASS. **Phase 0 gate.** Flaky: `clean-worktree-paths` 2/3. In one trial the reviewer flagged (major, `GEN-correctness`) an import of `./slug.ts`, which isn't in the diff. That's fair, because nothing said cases are excerpts. Fixed in the eval prompt, not the case. |
| 2026-09-27 | claude-opus-5-5 | n/a (clean only) | 0 | 0 | ≈ $0.28 | CC 2.1.283; trials 3; PASS. Re-ran `clean-worktree-paths` and `clean-hook-ingest` (which has the same pattern) after the excerpt note was added to `buildPrompt`: 3/3 each. The next full run should confirm planted-case recall is unchanged. |
| 2026-09-27 | claude-opus-5-5 | 3/3 (100%) | 0 | 0 | ≈ $0.21 | CC 2.1.283; trials 3; PASS. Rewrote `hook-token-on-ws` for ADR 0026: the WS upgrade now authorizes a cookie with Origin and Host checks, and the planted flaw is the extra hook-token path. The old version used the retired first-frame UI token. |
| 2026-09-28 | claude-opus-5-5 | 56/57 (98%) | 0 | 0 | ≈ $5.37 | CC 2.1.283; trials 3; PASS. **Phase 1 gate**, 20 cases, run as five groups because a single background run was stopped for low memory (2 of 60 trials done, ≈ $0.20). Flaky: `scrollback-without-headless-xterm` 2/3 (one trial found only the design's UTF-8 and escape-sequence splitting, not the missing ADR). It replaced `biome-to-eslint`, whose diff turned out to hold several real defects besides the planted one (dropped Biome rules despite a parity claim, incomplete env exemptions); the reviewer flagged them correctly (forbidden hits 2 of 3 trials), so the case, not the reviewer, was wrong. The five new 1.8 cases were first run once: 5/5, ≈ $0.69. |
| 2026-09-30 | claude-opus-5-5 | 31/31 (100%) | 0 | 0 | ≈ $3.90 | CC 2.1.285; trials 1; PASS. All 32 cases, after ADR 0031 and the reviewer's "theoretical → minor" rule (a trigger: `.claude/agents/` changed). `gemini-adapter-early` approved with its finding at minor, as in every earlier run: the catalog's default for `ARCH-scope-creep`, not a downgrade. The phase gate's 3-trial run at the end of Phase 2 follows. |
