import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCoverage, parsePlanTasks, parseUncovered, type UncoveredList } from './coverage.ts';
import { extractRuleCatalog, parseExpected } from './score.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const CASES_DIR = path.join(import.meta.dirname, 'cases');

function list(ids: readonly string[]): UncoveredList {
  return new Map(ids.map((id) => [id, 'no miss yet']));
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
  it('accepts rule → reason entries and skips $comment', () => {
    const parsed = parseUncovered({ $comment: 'x', 'A-rule': 'no miss yet' });
    expect(parsed.ok && [...parsed.value]).toEqual([['A-rule', 'no miss yet']]);
  });

  it.each([
    ['not an object', []],
    ['a reason that is not a string', { 'A-rule': { due: '2.9' } }],
    ['a blank reason', { 'A-rule': '  ' }],
  ])('rejects %s', (_label, value) => {
    expect(parseUncovered(value).ok).toBe(false);
  });
});

describe('checkCoverage', () => {
  const catalog = ['A-one', 'B-two'];

  it('passes when every rule is covered or listed', () => {
    expect(
      checkCoverage({ catalog, covered: new Set(['A-one']), uncovered: list(['B-two']) }),
    ).toEqual([]);
  });

  it('fails for a rule with neither a case nor a list entry', () => {
    expect(checkCoverage({ catalog, covered: new Set(['A-one']), uncovered: list([]) })).toEqual([
      expect.stringContaining('B-two has no eval case'),
    ]);
  });

  it('fails for listed rules that are covered or unknown', () => {
    expect(
      checkCoverage({
        catalog,
        covered: new Set(['A-one', 'B-two']),
        uncovered: list(['A-one', 'Z-gone']),
      }),
    ).toEqual([
      expect.stringContaining('A-one now has an eval case'),
      expect.stringContaining('Z-gone is in uncovered.json but not in'),
    ]);
  });
});

describe('the repository eval coverage', () => {
  it('holds: every reviewer rule is covered by a case or listed with a reason', () => {
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
    expect(checkCoverage({ catalog, covered, uncovered: parsed.value })).toEqual([]);
  });
});
