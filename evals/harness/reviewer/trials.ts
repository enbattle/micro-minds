// Multi-trial aggregation for the reviewer evals (dev-harness.md principle 3: model-judged evals
// run with multiple trials). Pure, so the pass rule, the table and the baseline row are tested
// in trials.test.ts; run.ts does the I/O.
//
// A trial is one reviewer session on one case. It passes by casePassed() in score.ts; an errored
// trial is a failed trial. A case passes when at least requiredPasses(n) of its n trials passed.
// The run fails when a case misses that count, when recall over all trials is below the
// threshold, or when any trial errored (an error is a harness or CLI problem, not a verdict).

import {
  type CaseScore,
  casePassed,
  formatRatio,
  formatSummaryTable,
  RECALL_THRESHOLD,
  type Summary,
  summarize,
} from './score.ts';
import { describeModels } from './versions.ts';

export const MIN_TRIALS = 1;
export const MAX_TRIALS = 10;

/** Parses the --trials flag: an integer from MIN_TRIALS to MAX_TRIALS, default 1. */
export function parseTrials(raw: string | undefined): number {
  if (raw === undefined) return MIN_TRIALS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_TRIALS || value > MAX_TRIALS) {
    throw new Error(`--trials must be an integer from ${MIN_TRIALS} to ${MAX_TRIALS}`);
  }
  return value;
}

/** Passing trials a case needs out of n: ceil(2n/3), so 1/1, 2/2, 2/3, 3/4, 4/5, 4/6, ... */
export function requiredPasses(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`trial count must be a positive integer`);
  return Math.ceil((2 * n) / 3);
}

export interface CaseTrials {
  name: string;
  clean: boolean;
  trials: number;
  passes: number;
  errors: number;
  required: number;
  passed: boolean;
  /** Passed some trials but not all. */
  flaky: boolean;
  scores: CaseScore[];
}

export function aggregateCase(scores: readonly CaseScore[]): CaseTrials {
  const first = scores[0];
  if (first === undefined) throw new Error('a case needs at least one trial');
  const mixed = scores.find((s) => s.name !== first.name);
  if (mixed !== undefined) throw new Error(`trials of "${first.name}" include "${mixed.name}"`);
  const trials = scores.length;
  const passes = scores.filter(casePassed).length;
  const required = requiredPasses(trials);
  return {
    name: first.name,
    clean: first.clean,
    trials,
    passes,
    errors: scores.filter((s) => s.status === 'error').length,
    required,
    passed: passes >= required,
    flaky: passes > 0 && passes < trials,
    scores: [...scores],
  };
}

export interface TrialsReport {
  trials: number;
  cases: CaseTrials[];
  /** summarize() over every trial of every case: recall, errors and hits count all trials. */
  summary: Summary;
  passed: boolean;
  reasons: string[];
}

/** Aggregates per-case trial scores. Every case must have the same number of trials. */
export function summarizeTrials(
  perCase: readonly (readonly CaseScore[])[],
  threshold = RECALL_THRESHOLD,
): TrialsReport {
  const cases = perCase.map(aggregateCase);
  const trials = cases[0]?.trials ?? MIN_TRIALS;
  const uneven = cases.find((c) => c.trials !== trials);
  if (uneven !== undefined) {
    throw new Error(`"${uneven.name}" has ${uneven.trials} trial(s), expected ${trials}`);
  }
  const summary = summarize(
    cases.flatMap((c) => c.scores),
    threshold,
  );
  const reasons: string[] = [];
  if (summary.recall < threshold) {
    reasons.push(
      `recall ${formatRatio(summary.recall)} is below the ${formatRatio(threshold)} threshold`,
    );
  }
  for (const c of cases.filter((x) => !x.passed)) {
    reasons.push(`${c.name} passed ${c.passes}/${c.trials} trial(s), needs ${c.required}`);
  }
  if (summary.errors > 0) {
    reasons.push(`${summary.errors} of ${summary.cases} trial(s) errored`);
  }
  return { trials, cases, summary, passed: reasons.length === 0, reasons };
}

function countIds(lists: readonly (readonly string[])[]): string {
  const counts = new Map<string, number>();
  for (const id of lists.flat()) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([id, n]) => `${id}(${n})`).join(' ') || '-';
}

function trialsRow(c: CaseTrials): string[] {
  const sum = (pick: (s: CaseScore) => number): number => c.scores.reduce((n, s) => n + pick(s), 0);
  const verdictsOk = c.scores.filter((s) => s.verdictAsExpected).length;
  let result = c.passed ? 'PASS' : 'FAIL';
  if (!c.passed && c.errors === c.trials) result = 'ERROR';
  return [
    c.name,
    c.clean ? 'clean' : 'planted',
    c.clean ? '-' : `${sum((s) => s.found.length)}/${sum((s) => s.mustFind.length)}`,
    countIds(c.scores.map((s) => s.missed)),
    countIds(c.scores.map((s) => s.forbiddenHits)),
    c.clean ? String(sum((s) => s.falsePositives.length)) : '-',
    `ok ${verdictsOk}/${c.trials}${verdictsOk === c.trials ? '' : ' (!)'}`,
    `${c.passes}/${c.trials}`,
    result,
  ];
}

/** The flaky-case line printed under a multi-trial table. */
export function formatFlaky(report: TrialsReport): string {
  const flaky = report.cases.filter((c) => c.flaky);
  if (flaky.length === 0) return 'Flaky cases: none';
  const list = flaky.map((c) => `${c.name} ${c.passes}/${c.trials}${c.passed ? '' : ' (FAIL)'}`);
  return `Flaky cases (passed some but not all trials): ${list.join(', ')}`;
}

/**
 * Terminal table. With one trial it is formatSummaryTable() unchanged apart from the verdict;
 * with more, each row aggregates a case's trials (found and hits summed, missed and forbidden
 * ids with their counts), a `trials` column shows passes/n, and flaky cases follow the totals.
 */
export function formatTrialsTable(report: TrialsReport): string {
  const { summary, trials } = report;
  if (trials === 1) {
    return formatSummaryTable(
      report.cases.flatMap((c) => c.scores),
      { ...summary, passed: report.passed, reasons: report.reasons },
    );
  }
  const header = [
    'case',
    'type',
    'found',
    'missed',
    'forbidden',
    'false+',
    'verdict',
    'trials',
    'result',
  ];
  const rows = report.cases.map(trialsRow);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const casesOk = report.cases.filter((c) => c.passed).length;
  const totals =
    `recall ${summary.mustFindFound}/${summary.mustFindTotal} = ${formatRatio(summary.recall)} ` +
    `over ${trials} trials per case (threshold ${formatRatio(summary.threshold)}), cases with ` +
    `>= ${requiredPasses(trials)}/${trials} passing trials: ${casesOk}/${report.cases.length}, ` +
    `clean-case false-positive trials: ${summary.cleanCasesWithFalsePositives}, forbidden hits: ` +
    `${summary.forbiddenHits}, errored trials: ${summary.errors} -> ` +
    `${report.passed ? 'PASS' : 'FAIL'}`;
  return [
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    totals,
    formatFlaky(report),
  ].join('\n');
}

/** YYYY-MM-DD in local time. */
export function localDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface BaselineRowInput {
  date: Date;
  models: readonly string[];
  modelFlag: string | undefined;
  claudeCodeVersion: string;
  totalCostUsd: number;
  report: TrialsReport;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * A row for the README "Baseline history" table:
 * | Date | Reviewer model | Recall | Clean-case false positives | Forbidden hits | Cost | Notes |
 * Counts are over all trials. Notes start with the Claude Code version and the trial count.
 */
export function formatBaselineRow(input: BaselineRowInput): string {
  const { report } = input;
  const { summary } = report;
  const notes = [`CC ${input.claudeCodeVersion}`, `trials ${report.trials}`];
  notes.push(report.passed ? 'PASS' : `FAIL: ${report.reasons.join('; ')}`);
  const flaky = report.cases.filter((c) => c.flaky);
  if (flaky.length > 0) {
    notes.push(`flaky: ${flaky.map((c) => `${c.name} ${c.passes}/${c.trials}`).join(', ')}`);
  }
  const cells = [
    localDate(input.date),
    describeModels(input.models, input.modelFlag),
    `${summary.mustFindFound}/${summary.mustFindTotal} (${formatRatio(summary.recall)})`,
    String(summary.cleanCasesWithFalsePositives),
    String(summary.forbiddenHits),
    `≈ $${input.totalCostUsd.toFixed(2)}`,
    `${notes.join('; ')}.`,
  ];
  return `| ${cells.map(cell).join(' | ')} |`;
}
