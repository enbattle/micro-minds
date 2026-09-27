// Deterministic checks on the eval cases themselves, so a broken case fails in CI even though
// the token-spending runner never runs there.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkUnifiedDiff, extractRuleCatalog, parseExpected } from './score.ts';

const CASES_DIR = path.join(import.meta.dirname, 'cases');
const AGENT_FILE = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '.claude',
  'agents',
  'reviewer.md',
);

const catalog = extractRuleCatalog(readFileSync(AGENT_FILE, 'utf8'));
const cases = readdirSync(CASES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function load(name: string) {
  const dir = path.join(CASES_DIR, name);
  return {
    diff: readFileSync(path.join(dir, 'change.diff'), 'utf8'),
    expected: parseExpected(
      JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8')),
      catalog,
    ),
  };
}

describe('reviewer rule catalog', () => {
  it('defines unique ids for every rule family', () => {
    expect(new Set(catalog).size).toBe(catalog.length);
    for (const prefix of [
      'HR1-',
      'HR12-',
      'SEC-',
      'CONV-',
      'ARCH-',
      'D22-',
      'WIN-',
      'TEST-',
      'GEN-',
    ]) {
      expect(catalog.some((id) => id.startsWith(prefix))).toBe(true);
    }
  });
});

describe('reviewer eval cases', () => {
  it('has at least 8 planted cases, 2 clean cases and 1 case with two planted rules', () => {
    const expectations = cases.map((name) => load(name).expected);
    const mustFind = expectations.map((e) => (e.ok ? e.value.mustFind.length : -1));
    expect(mustFind.filter((n) => n > 0).length).toBeGreaterThanOrEqual(8);
    expect(mustFind.filter((n) => n === 0).length).toBeGreaterThanOrEqual(2);
    expect(mustFind.some((n) => n >= 2)).toBe(true);
  });

  it.each(cases)('%s has a valid diff and expected.json', (name) => {
    const { diff, expected } = load(name);
    const diffCheck = checkUnifiedDiff(diff);
    expect(diffCheck.ok, diffCheck.ok ? '' : diffCheck.error).toBe(true);
    expect(expected.ok, expected.ok ? '' : expected.error).toBe(true);
    expect(diff).not.toContain('\r');
  });
});
