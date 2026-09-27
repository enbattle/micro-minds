import { describe, expect, it } from 'vitest';
import {
  type CaseScore,
  type Expected,
  type Finding,
  formatSummaryTable,
  scoreCase,
  scoreErroredCase,
  summarize,
} from './score.ts';
import {
  aggregateCase,
  cell,
  formatBaselineRow,
  formatFlaky,
  formatTrialsTable,
  localDate,
  parseTrials,
  requiredPasses,
  summarizeTrials,
} from './trials.ts';

const CATALOG = ['HR3-localhost-bind', 'HR8-raw-leak', 'CONV-any', 'GEN-correctness'];
const BIND: Expected = {
  mustFind: ['HR3-localhost-bind'],
  mustNotFind: ['HR8-raw-leak'],
  notes: 'n',
};
const CLEAN: Expected = { mustFind: [], mustNotFind: [], notes: 'n' };

function finding(ruleId: string, severity: Finding['severity'] = 'blocker'): Finding {
  return { ruleId, severity, file: 'a.ts', line: 1, summary: 's' };
}

/** A trial of the planted `bind` case: 'pass' finds the rule, 'miss' doesn't, 'error' errors. */
function bind(outcome: 'pass' | 'miss' | 'forbidden' | 'error', name = 'bind'): CaseScore {
  if (outcome === 'error') return scoreErroredCase(name, BIND, 'timed out');
  const findings =
    outcome === 'miss'
      ? []
      : outcome === 'forbidden'
        ? [finding('HR3-localhost-bind'), finding('HR8-raw-leak', 'minor')]
        : [finding('HR3-localhost-bind')];
  return scoreCase(name, BIND, { findings, verdict: 'changes_requested' }, CATALOG);
}

function clean(outcome: 'pass' | 'fp' | 'error', name = 'clean'): CaseScore {
  if (outcome === 'error') return scoreErroredCase(name, CLEAN, 'boom');
  const findings = outcome === 'fp' ? [finding('GEN-correctness', 'major')] : [];
  const verdict = outcome === 'fp' ? 'changes_requested' : 'approve';
  return scoreCase(name, CLEAN, { findings, verdict }, CATALOG);
}

describe('requiredPasses', () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 4],
    [6, 4],
    [7, 5],
    [9, 6],
    [10, 7],
  ])('%i trials need %i passes', (n, required) => {
    expect(requiredPasses(n)).toBe(required);
  });

  it('is always a strict majority and never more than n', () => {
    for (let n = 1; n <= 10; n++) {
      expect(requiredPasses(n)).toBeGreaterThan(n / 2);
      expect(requiredPasses(n)).toBeLessThanOrEqual(n);
    }
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects %d', (n) => {
    expect(() => requiredPasses(n)).toThrow('positive integer');
  });
});

describe('parseTrials', () => {
  it('defaults to 1 and accepts 1..10', () => {
    expect(parseTrials(undefined)).toBe(1);
    expect(parseTrials('1')).toBe(1);
    expect(parseTrials('10')).toBe(10);
  });

  it.each(['0', '11', '2.5', 'three', '', '-1'])('rejects %j', (raw) => {
    expect(() => parseTrials(raw)).toThrow('--trials must be an integer from 1 to 10');
  });
});

describe('aggregateCase', () => {
  it('all pass', () => {
    expect(aggregateCase([bind('pass'), bind('pass'), bind('pass')])).toMatchObject({
      name: 'bind',
      trials: 3,
      passes: 3,
      required: 2,
      passed: true,
      flaky: false,
      errors: 0,
    });
  });

  it('flaky but ok: 2 of 3', () => {
    expect(aggregateCase([bind('pass'), bind('miss'), bind('pass')])).toMatchObject({
      passes: 2,
      passed: true,
      flaky: true,
    });
  });

  it('flaky and failing: 1 of 3, a forbidden hit fails its trial', () => {
    expect(aggregateCase([bind('pass'), bind('forbidden'), bind('miss')])).toMatchObject({
      passes: 1,
      passed: false,
      flaky: true,
    });
  });

  it('all error: every trial failed, not flaky', () => {
    expect(aggregateCase([bind('error'), bind('error')])).toMatchObject({
      passes: 0,
      errors: 2,
      required: 2,
      passed: false,
      flaky: false,
    });
  });

  it('an errored trial counts as a failed trial', () => {
    expect(aggregateCase([clean('pass'), clean('error'), clean('pass')])).toMatchObject({
      clean: true,
      passes: 2,
      errors: 1,
      passed: true,
      flaky: true,
    });
  });

  it('needs every trial at n = 2', () => {
    expect(aggregateCase([bind('pass'), bind('miss')]).passed).toBe(false);
  });

  it('rejects no trials and mixed cases', () => {
    expect(() => aggregateCase([])).toThrow('at least one trial');
    expect(() => aggregateCase([bind('pass'), bind('pass', 'other')])).toThrow('include "other"');
  });
});

describe('summarizeTrials', () => {
  it('all pass', () => {
    const report = summarizeTrials([
      [bind('pass'), bind('pass'), bind('pass')],
      [clean('pass'), clean('pass'), clean('pass')],
    ]);
    expect(report).toMatchObject({ trials: 3, passed: true, reasons: [] });
    expect(report.summary).toMatchObject({ cases: 6, mustFindTotal: 3, mustFindFound: 3 });
  });

  it('flaky but ok: recall counts every trial', () => {
    const report = summarizeTrials([
      [bind('pass'), bind('pass'), bind('pass')],
      [bind('pass', 'b2'), bind('pass', 'b2'), bind('pass', 'b2')],
      [bind('pass', 'b3'), bind('pass', 'b3'), bind('pass', 'b3')],
      [bind('miss', 'b4'), bind('pass', 'b4'), bind('pass', 'b4')],
      [clean('pass'), clean('fp'), clean('pass')],
    ]);
    expect(report.summary.mustFindFound).toBe(11);
    expect(report.summary.mustFindTotal).toBe(12);
    expect(report.summary.cleanCasesWithFalsePositives).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.cases.filter((c) => c.flaky).map((c) => c.name)).toEqual(['b4', 'clean']);
  });

  it('flaky fail: a case below its required passes fails the run', () => {
    const report = summarizeTrials([
      [bind('pass'), bind('pass'), bind('pass')],
      [bind('pass', 'b2'), bind('pass', 'b2'), bind('pass', 'b2')],
      [bind('pass', 'b3'), bind('pass', 'b3'), bind('pass', 'b3')],
      [clean('fp'), clean('pass'), clean('fp')],
    ]);
    expect(report.summary.recall).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.reasons).toEqual(['clean passed 1/3 trial(s), needs 2']);
  });

  it('fails on recall below the threshold even when every case meets its count', () => {
    const cases = ['a', 'b', 'c'].map((n) => [bind('pass', n), bind('pass', n), bind('miss', n)]);
    const report = summarizeTrials(cases);
    expect(report.cases.every((c) => c.passed)).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.reasons).toEqual(['recall 67% is below the 80% threshold']);
  });

  it('all error', () => {
    const report = summarizeTrials([
      [bind('error'), bind('error'), bind('error')],
      [clean('error'), clean('error'), clean('error')],
    ]);
    expect(report.passed).toBe(false);
    expect(report.summary.errors).toBe(6);
    expect(report.reasons).toEqual([
      'recall 0% is below the 80% threshold',
      'bind passed 0/3 trial(s), needs 2',
      'clean passed 0/3 trial(s), needs 2',
      '6 of 6 trial(s) errored',
    ]);
  });

  it('mixed: any errored trial fails the run even when its case meets the count', () => {
    const report = summarizeTrials([
      [bind('pass'), bind('error'), bind('pass')],
      [bind('pass', 'b2'), bind('pass', 'b2'), bind('pass', 'b2')],
      [bind('pass', 'b3'), bind('pass', 'b3'), bind('pass', 'b3')],
      [bind('pass', 'b4'), bind('pass', 'b4'), bind('pass', 'b4')],
      [bind('pass', 'b5'), bind('pass', 'b5'), bind('pass', 'b5')],
      [clean('pass'), clean('pass'), clean('pass')],
    ]);
    expect(report.cases.every((c) => c.passed)).toBe(true);
    expect(report.summary.recall).toBeCloseTo(14 / 15);
    expect(report.reasons).toEqual(['1 of 18 trial(s) errored']);
    expect(report.passed).toBe(false);
  });

  it('with one trial, any miss, forbidden hit or false positive fails its case', () => {
    const report = summarizeTrials([[bind('forbidden')], [clean('pass')]]);
    expect(report.trials).toBe(1);
    expect(report.reasons).toEqual(['bind passed 0/1 trial(s), needs 1']);
  });

  it('rejects uneven trial counts', () => {
    expect(() => summarizeTrials([[bind('pass')], [clean('pass'), clean('pass')]])).toThrow(
      'has 2 trial(s), expected 1',
    );
  });

  it('treats no cases as a passing single-trial run', () => {
    expect(summarizeTrials([])).toMatchObject({ trials: 1, passed: true });
  });
});

describe('formatTrialsTable', () => {
  it('with one trial is the single-run table', () => {
    const perCase = [[bind('pass')], [clean('fp')]];
    const report = summarizeTrials(perCase);
    const scores = perCase.flat();
    expect(formatTrialsTable(report)).toBe(formatSummaryTable(scores, summarize(scores)));
    expect(formatTrialsTable(report)).not.toContain('trials');
  });

  it('uses the trial verdict in the single-run totals line', () => {
    // 4 of 5 found is 80% recall, which summarize() alone passes; the missed case fails it.
    const perCase = ['a', 'b', 'c', 'd', 'e'].map((n) => [bind(n === 'e' ? 'miss' : 'pass', n)]);
    const report = summarizeTrials(perCase);
    expect(summarize(perCase.flat()).passed).toBe(true);
    expect(formatTrialsTable(report).split('\n').at(-1)).toMatch(/-> FAIL$/);
  });

  it('adds a trials column, aggregates rows and lists flaky cases', () => {
    const report = summarizeTrials([
      [bind('pass'), bind('miss'), bind('forbidden')],
      [clean('pass'), clean('fp'), clean('pass')],
      [bind('error', 'broken'), bind('error', 'broken'), bind('error', 'broken')],
    ]);
    const lines = formatTrialsTable(report).split('\n');
    expect(lines[0]).toMatch(
      /^case\s+type\s+found\s+missed\s+forbidden\s+false\+\s+verdict\s+trials\s+result$/,
    );
    expect(lines[2]).toMatch(
      /^bind\s+planted\s+2\/3\s+HR3-localhost-bind\(1\)\s+HR8-raw-leak\(1\)\s+-\s+ok 3\/3\s+1\/3\s+FAIL$/,
    );
    expect(lines[3]).toMatch(/^clean\s+clean\s+-\s+-\s+-\s+1\s+ok 2\/3 \(!\)\s+2\/3\s+PASS$/);
    expect(lines[4]).toMatch(
      /^broken\s+planted\s+0\/3\s+HR3-localhost-bind\(3\)\s+.*0\/3\s+ERROR$/,
    );
    expect(lines.at(-2)).toContain('recall 2/6 = 33% over 3 trials per case');
    expect(lines.at(-2)).toContain('>= 2/3 passing trials: 1/3');
    expect(lines.at(-2)).toMatch(/errored trials: 3 -> FAIL$/);
    expect(lines.at(-1)).toBe(
      'Flaky cases (passed some but not all trials): bind 1/3 (FAIL), clean 2/3',
    );
  });

  it('says so when nothing is flaky', () => {
    const report = summarizeTrials([[bind('pass'), bind('pass')]]);
    expect(formatFlaky(report)).toBe('Flaky cases: none');
    expect(formatTrialsTable(report).split('\n').at(-1)).toBe('Flaky cases: none');
  });
});

describe('localDate', () => {
  it('formats local calendar fields', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDate(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });
});

describe('formatBaselineRow', () => {
  const date = new Date(2026, 8, 27, 14, 0);

  it('matches the README baseline columns', () => {
    const report = summarizeTrials([
      [bind('pass'), bind('pass'), bind('miss')],
      [clean('pass'), clean('pass'), clean('pass')],
    ]);
    const row = formatBaselineRow({
      date,
      models: ['claude-opus-5-5', 'claude-haiku-4-5'],
      modelFlag: undefined,
      claudeCodeVersion: '2.1.283',
      totalCostUsd: 1.234,
      report,
    });
    expect(row).toBe(
      '| 2026-09-27 | claude-opus-5-5, claude-haiku-4-5 | 2/3 (67%) | 0 | 0 | ≈ $1.23 | ' +
        'CC 2.1.283; trials 3; FAIL: recall 67% is below the 80% threshold; flaky: bind 2/3. |',
    );
    expect(row.split(' | ')).toHaveLength(7);
  });

  it('notes the --model flag when the model is unknown and a passing run', () => {
    const report = summarizeTrials([[bind('pass')], [clean('pass')]]);
    const row = formatBaselineRow({
      date,
      models: ['unknown'],
      modelFlag: 'opus',
      claudeCodeVersion: 'unknown',
      totalCostUsd: 0,
      report,
    });
    expect(row).toBe(
      '| 2026-09-27 | unknown (--model opus) | 1/1 (100%) | 0 | 0 | ≈ $0.00 | CC unknown; trials 1; PASS. |',
    );
  });

  it('escapes pipes inside cells', () => {
    const report = summarizeTrials([[bind('pass', 'a|b')]]);
    const row = formatBaselineRow({
      date,
      models: ['m|x'],
      modelFlag: undefined,
      claudeCodeVersion: '1.0.0',
      totalCostUsd: 0,
      report,
    });
    expect(row).toContain('m\\|x');
  });
});

describe('cell', () => {
  it.each([
    ['a|b', 'a|b'],
    ['a|b', 'a\\|b'],
    ['C:path', 'C:\\path'],
    ['line1\nline2\r\nline3', 'line1 line2 line3'],
  ])('escapes %j', (input, expected) => {
    expect(cell(input)).toBe(expected);
  });
});
