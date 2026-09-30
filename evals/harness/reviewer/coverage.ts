// Eval coverage accounting (docs/dev-harness.md, principle 1: checks beat prose; ADR 0031).
//
// Every reviewer rule ID is either exercised by an eval case (`mustFind`) or listed in
// `uncovered.json` with the reason it has no case yet. New cases come from real misses and
// confirmed false positives, not from a schedule, so the list says what isn't measured without
// forcing a case per rule per task.

import type { Parsed } from './score.ts';

/** Rule id → why it has no eval case yet. */
export type UncoveredList = ReadonlyMap<string, string>;

// `- [ ] 2.9 ...` or `- [x] 2.9 ...` in docs/PLAN.md §10.
const TASK_LINE = /^- \[( |x)\] (\d+[a-z]?\.\d+) /gm;

/** Parses the task checkboxes in PLAN.md into `task id → done`. */
export function parsePlanTasks(planMarkdown: string): ReadonlyMap<string, boolean> {
  const tasks = new Map<string, boolean>();
  for (const match of planMarkdown.matchAll(TASK_LINE)) {
    const [, mark, id] = match;
    if (id !== undefined) tasks.set(id, mark === 'x');
  }
  return tasks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the shape of `uncovered.json`: `{ "<rule id>": "<why>" }`. */
export function parseUncovered(value: unknown): Parsed<UncoveredList> {
  if (!isRecord(value)) return { ok: false, error: 'uncovered.json must be an object' };
  const list = new Map<string, string>();
  for (const [ruleId, why] of Object.entries(value)) {
    if (ruleId === '$comment') continue;
    if (typeof why !== 'string' || why.trim().length === 0) {
      return { ok: false, error: `${ruleId}: give the reason it has no eval case yet` };
    }
    list.set(ruleId, why);
  }
  return { ok: true, value: list };
}

export interface CoverageInput {
  readonly catalog: readonly string[];
  /** Rule IDs that appear in at least one case's `mustFind`. */
  readonly covered: ReadonlySet<string>;
  readonly uncovered: UncoveredList;
}

/** Returns every mismatch between the catalog, the cases and the list; empty means it holds. */
export function checkCoverage({ catalog, covered, uncovered }: CoverageInput): string[] {
  const errors: string[] = [];
  const known = new Set(catalog);
  for (const ruleId of catalog) {
    if (!covered.has(ruleId) && !uncovered.has(ruleId)) {
      errors.push(`${ruleId} has no eval case: add one, or list it in uncovered.json with why`);
    }
  }
  for (const ruleId of uncovered.keys()) {
    if (!known.has(ruleId)) {
      errors.push(`${ruleId} is in uncovered.json but not in the reviewer's rule catalog`);
    } else if (covered.has(ruleId)) {
      errors.push(`${ruleId} now has an eval case: remove it from uncovered.json`);
    }
  }
  return errors;
}
