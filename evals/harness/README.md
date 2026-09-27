# Harness evals

The AI developer harness (`CLAUDE.md`, `.claude/agents/`, `.claude/skills/`, `.claude/hooks/`) is code, so it gets tested too (PLAN §11.1). There are two suites:

| Suite | What it checks | Deterministic | Runs in CI |
|---|---|---|---|
| **Guard evals** (`guard/`) | The `PreToolUse` guard hook allows and blocks a table of commands | yes | yes (`npm test`) |
| **Reviewer evals** (`reviewer/`) | The `reviewer` agent finds planted violations and stays quiet on clean code | no (calls the model) | **no**: costs tokens |

The reviewer suite also has deterministic parts that do run in CI through the `harness` Vitest project: `score.test.ts`, `invocation.test.ts`, `resolve-bin.test.ts`, and `cases.test.ts`, which validates every case file against the agent's rule catalog.

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
- **Error**: the CLI failed, timed out, hit the turn or budget cap, or the final ```json block didn't parse. Its planted rules count as missed.

The run **fails** (exit 1) if recall is below `RECALL_THRESHOLD` (0.8, in `reviewer/score.ts`), or if there is any clean-case false positive, mustNotFind hit or errored case. Verdict mismatches and rule IDs outside the catalog are reported but don't fail the run.

### Running

```sh
npm run eval:harness                                  # all cases
npm run eval:harness -- bind-all-interfaces raw-over-ws   # selected cases
npm run eval:harness -- --dry-run                     # validate cases, print the command, spend nothing
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
2. Write `change.diff` as a real unified diff with `a/`/`b/` paths as they would be in this repo (`git diff` output, LF line endings). Keep it small and otherwise correct, so the only defects are the planted ones. Put a plausible justification next to the violation so it takes a careful read to spot it. Clean cases should include their tests.
3. Write `expected.json`. `mustFind` lists every planted rule ID. `mustNotFind` lists nearby rules the code deliberately satisfies (for example `SEC-token-compare` when the code does use `timingSafeEqual`). `notes` explains both.
4. If a new rule ID is needed, add it to a catalog table in `.claude/agents/reviewer.md` first.
5. Run `npm run eval:harness -- --dry-run` and `npx vitest run --project harness`, then run the new case for real: `npm run eval:harness -- <kebab-name>`.
