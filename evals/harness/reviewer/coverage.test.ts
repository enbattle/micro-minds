import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkCoverage,
  parsePlanTasks,
  parseUncovered,
  rulesDueWith,
  type UncoveredSchedule,
} from './coverage.ts';
import { extractRuleCatalog, parseExpected } from './score.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CASES_DIR = path.join(import.meta.dirname, 'cases');

function schedule(entries: Record<string, string>): UncoveredSchedule {
  return new Map(Object.entries(entries).map(([id, due]) => [id, { due, why: 'test' }]));
}

describe('parsePlanTasks', () => {
  it('reads ticked and unticked task ids, including 4a-style ids', () => {
    const plan = [
      '- [x] 0.1 Scaffold',
      '- [ ] 2.14 Usage capture',
      '- [ ] 4a.7 Demo mode',
      '  - [x] 9.9 indented lines are not tasks',
      '- [x] not-a-task line',
    ].join('\n');
    expect([...parsePlanTasks(plan)]).toEqual([
      ['0.1', true],
      ['2.14', false],
      ['4a.7', false],
    ]);
  });
});

describe('parseUncovered', () => {
  it('accepts valid entries and skips $comment', () => {
    const parsed = parseUncovered({ $comment: 'x', 'A-rule': { due: '2.9', why: 'server' } });
    expect(parsed.ok && [...parsed.value]).toEqual([['A-rule', { due: '2.9', why: 'server' }]]);
  });

  it.each([
    ['not an object', []],
    ['entry not an object', { 'A-rule': '2.9' }],
    ['bad task id', { 'A-rule': { due: 'phase 2', why: 'x' } }],
    ['missing why', { 'A-rule': { due: '2.9' } }],
    ['blank why', { 'A-rule': { due: '2.9', why: '  ' } }],
  ])('rejects %s', (_label, value) => {
    expect(parseUncovered(value).ok).toBe(false);
  });
});

describe('checkCoverage', () => {
  const tasks = new Map([
    ['1.4', true],
    ['2.9', false],
  ]);
  const base = { catalog: ['A-one', 'B-two'], tasks };

  it('passes when every rule is covered or scheduled against future work', () => {
    const errors = checkCoverage({
      ...base,
      covered: new Set(['A-one']),
      schedule: schedule({ 'B-two': '2.9' }),
    });
    expect(errors).toEqual([]);
  });

  it('fails for a rule with neither a case nor a schedule entry', () => {
    const errors = checkCoverage({ ...base, covered: new Set(['A-one']), schedule: new Map() });
    expect(errors).toEqual([expect.stringContaining('B-two has no eval case')]);
  });

  it('fails when a rule is overdue because its task is ticked', () => {
    const errors = checkCoverage({
      ...base,
      covered: new Set(['A-one']),
      schedule: schedule({ 'B-two': '1.4' }),
    });
    expect(errors).toEqual([expect.stringContaining('B-two was due with task 1.4')]);
  });

  it('fails for stale, unknown and mis-scheduled entries', () => {
    const errors = checkCoverage({
      ...base,
      covered: new Set(['A-one', 'B-two']),
      schedule: schedule({ 'A-one': '2.9', 'Z-gone': '2.9' }),
    });
    expect(errors).toEqual([
      expect.stringContaining('A-one now has an eval case'),
      expect.stringContaining('Z-gone is in uncovered.json but not in'),
    ]);
    const missingTask = checkCoverage({
      ...base,
      covered: new Set(['A-one']),
      schedule: schedule({ 'B-two': '7.1' }),
    });
    expect(missingTask).toEqual([expect.stringContaining("7.1, which doesn't exist")]);
  });

  it('lists the rules due with a task, sorted', () => {
    expect(rulesDueWith('2.9', schedule({ 'C-x': '2.9', 'A-y': '2.9', 'B-z': '1.4' }))).toEqual([
      'A-y',
      'C-x',
    ]);
  });
});

describe('the repository coverage schedule', () => {
  it('holds: every reviewer rule is covered by a case or scheduled against an unticked task', () => {
    const catalog = extractRuleCatalog(
      readFileSync(path.join(REPO_ROOT, '.claude', 'agents', 'reviewer.md'), 'utf8'),
    );
    const covered = new Set<string>();
    for (const entry of readdirSync(CASES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const raw: unknown = JSON.parse(
        readFileSync(path.join(CASES_DIR, entry.name, 'expected.json'), 'utf8'),
      );
      const expected = parseExpected(raw, catalog);
      if (expected.ok) for (const ruleId of expected.value.mustFind) covered.add(ruleId);
    }
    const parsed = parseUncovered(
      JSON.parse(readFileSync(path.join(import.meta.dirname, 'uncovered.json'), 'utf8')),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const tasks = parsePlanTasks(readFileSync(path.join(REPO_ROOT, 'docs', 'PLAN.md'), 'utf8'));

    expect(checkCoverage({ catalog, covered, schedule: parsed.value, tasks })).toEqual([]);
  });
});
