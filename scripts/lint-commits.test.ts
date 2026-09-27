import { describe, expect, it } from 'vitest';
import { checkSubject, checkSubjects, MAX_SUBJECT_LENGTH } from './lint-commits.ts';

// `git log --format=%s -n 40` on this repository when the lint was added. All must pass.
const REPO_SUBJECTS = [
  'Merge pull request #3: harness eval coverage schedule, trials, principles',
  'test(harness): tell the reviewer eval diffs are excerpts; record Phase 0 gate',
  'test(harness): fix cell escaping test expectations',
  'fix(harness): escape backslashes before pipes in baseline table cells',
  'feat(harness): add --trials and record exact model and Claude Code versions',
  'test(harness): enforce a schedule for reviewer rules without eval cases',
  'docs(harness): add harness principles and a deferred-practices register',
  'test(harness): make clean-hook-ingest eval case genuinely clean, record baseline',
  'Merge pull request #1: Phase 0 foundations, dev harness, CI and ADRs',
  'docs: tick task 0.10 after CI passed on Linux, macOS and Windows',
  'fix(server): restore exec bit on node-pty macOS spawn-helper after install',
  'docs: plan usage and cost monitoring from CLI telemetry (D25)',
  'fix(harness): require Node 24.2+ and kill the process tree on eval timeout',
  'feat(harness): add reviewer evals with planted-violation cases and runner',
  'feat(harness): add reviewer and test-writer subagents and project skills',
  'docs: document the dev harness and the ~/.claude guard exemption',
  'feat(harness): exempt Claude Code working files under ~/.claude from the guard',
  'feat(harness): add Claude Code settings, PreToolUse guard and format hooks',
  'docs(adr): record decisions D1-D23 as ADRs 0001-0023 with template and index',
  'ci: add lint/typecheck/test matrix on Linux, macOS, Windows and Dependabot',
  'docs: add per-package CLAUDE.md files',
  'chore: scaffold npm-workspaces monorepo with strict TS, Biome, Vitest',
  'docs: add build plan v2 and CLAUDE.md',
  'Initial commit',
];

const VALID = [
  'feat: add a thing',
  'fix(server): handle unknown events',
  'docs(adr): record decision 0024',
  'style: format with biome',
  'refactor(shared): split reduce into smaller steps',
  'perf(web): memoize the agent list',
  'test(hook-relay): cover the timeout path',
  'build: bump typescript to 7.0.3',
  'ci: add coverage step',
  'chore(deps): bump vitest from 5.0.2 to 5.0.3',
  'chore(deps-dev): bump @types/node',
  'revert: undo the relay change',
  'feat!: drop node 22',
  'feat(server)!: change the ws protocol',
  'fix(providers/claude): map SubagentStop',
  'fix(v2): handle 2 providers',
  'docs: `npm run check` must pass',
  'docs: 0.10 tick',
  `feat: ${'x'.repeat(MAX_SUBJECT_LENGTH - 'feat: '.length)}`,
  "Merge branch 'main' into feat/x",
  "Merge remote-tracking branch 'origin/main'",
  'Merge pull request #42 from user/branch',
  'Revert "feat: add a thing"',
];

const INVALID: Array<[subject: string, reason: RegExp]> = [
  ['', /empty/],
  ['   ', /empty/],
  ['add a thing', /expected/],
  ['feature: add a thing', /expected/],
  ['Feat: add a thing', /expected/],
  ['feat add a thing', /expected/],
  ['feat:add a thing', /expected/],
  ['feat: ', /description is empty/],
  ['feat:  ', /description is empty/],
  ['feat: Add a thing', /lowercase/],
  ['fix(server): Handle unknown events', /lowercase/],
  ['feat: add a thing.', /period/],
  ['feat(Server): add a thing', /scope/],
  ['feat(): add a thing', /scope/],
  ['feat(my scope): add a thing', /scope/],
  ['feat(-x): add a thing', /scope/],
  ['feat(a_b): add a thing', /scope/],
  ['feat!(server): add a thing', /expected/],
  [`feat: ${'x'.repeat(MAX_SUBJECT_LENGTH - 'feat: '.length + 1)}`, /characters/],
  ['Merge 1a2b3c4 into 5d6e7f8', /expected/],
  ['Revert feat: add a thing', /expected/],
  ['Update README.md', /expected/],
  ['WIP', /expected/],
  ['fixup! feat: add a thing', /expected/],
];

describe('checkSubject', () => {
  it.each(REPO_SUBJECTS)('accepts existing repo subject %j', (subject) => {
    expect(checkSubject(subject)).toEqual({ ok: true });
  });

  it.each(VALID)('accepts %j', (subject) => {
    expect(checkSubject(subject)).toEqual({ ok: true });
  });

  it.each(INVALID)('rejects %j', (subject, reason) => {
    const result = checkSubject(subject);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe('checkSubjects', () => {
  it('returns only the failures, in order, with reasons', () => {
    const failures = checkSubjects(['feat: ok', 'bad subject', 'fix: ok', 'fix: Bad']);
    expect(failures.map((f) => f.subject)).toEqual(['bad subject', 'fix: Bad']);
    expect(failures.every((f) => f.reason.length > 0)).toBe(true);
  });

  it('returns no failures for an empty list', () => {
    expect(checkSubjects([])).toEqual([]);
  });
});
