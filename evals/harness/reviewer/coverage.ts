// Eval-coverage schedule (docs/dev-harness.md, principle 1: checks beat prose).
//
// Every reviewer rule ID must either be exercised by an eval case (`mustFind`) or be listed in
// `uncovered.json` with the PLAN task whose code it governs. A test reads PLAN.md checkboxes, so a
// rule can't stay uncovered once its task is ticked. That is how the list can only shrink: a new
// rule may be scheduled against future work, but never against work that is already done.

import type { Parsed } from './score.ts';

export interface UncoveredEntry {
  readonly due: string;
  readonly why: string;
}

export type UncoveredSchedule = ReadonlyMap<string, UncoveredEntry>;

/** A PLAN task id: `0.3`, `2.14`, `4a.7`. */
const TASK_ID = /^\d+[a-z]?\.\d+$/;

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

/** Validates the shape of `uncovered.json`. Semantic checks live in `checkCoverage`. */
export function parseUncovered(value: unknown): Parsed<UncoveredSchedule> {
  if (!isRecord(value)) return { ok: false, error: 'uncovered.json must be an object' };
  const schedule = new Map<string, UncoveredEntry>();
  for (const [ruleId, entry] of Object.entries(value)) {
    if (ruleId === '$comment') continue;
    if (!isRecord(entry)) return { ok: false, error: `${ruleId}: entry must be an object` };
    const { due, why } = entry;
    if (typeof due !== 'string' || !TASK_ID.test(due)) {
      return { ok: false, error: `${ruleId}: "due" must be a PLAN task id like "2.9"` };
    }
    if (typeof why !== 'string' || why.trim().length === 0) {
      return { ok: false, error: `${ruleId}: "why" must explain which code the rule governs` };
    }
    schedule.set(ruleId, { due, why });
  }
  return { ok: true, value: schedule };
}

export interface CoverageInput {
  readonly catalog: readonly string[];
  /** Rule IDs that appear in at least one case's `mustFind`. */
  readonly covered: ReadonlySet<string>;
  readonly schedule: UncoveredSchedule;
  readonly tasks: ReadonlyMap<string, boolean>;
}

/** Returns every violation of the coverage schedule; an empty array means it holds. */
export function checkCoverage({ catalog, covered, schedule, tasks }: CoverageInput): string[] {
  const errors: string[] = [];
  const known = new Set(catalog);

  for (const ruleId of catalog) {
    if (!covered.has(ruleId) && !schedule.has(ruleId)) {
      errors.push(
        `${ruleId} has no eval case and isn't scheduled: add a case, or an uncovered.json entry due with a future task`,
      );
    }
  }

  for (const [ruleId, { due }] of schedule) {
    if (!known.has(ruleId)) {
      errors.push(`${ruleId} is in uncovered.json but not in the reviewer's rule catalog`);
      continue;
    }
    if (covered.has(ruleId)) {
      errors.push(`${ruleId} now has an eval case: remove it from uncovered.json`);
      continue;
    }
    const done = tasks.get(due);
    if (done === undefined) {
      errors.push(`${ruleId} is due with task ${due}, which doesn't exist in docs/PLAN.md`);
    } else if (done) {
      errors.push(
        `${ruleId} was due with task ${due}, which is ticked: add a planted eval case for it`,
      );
    }
  }

  return errors;
}

/** Uncovered rules due with a given task: what `start-task`/`phase-status` should surface. */
export function rulesDueWith(task: string, schedule: UncoveredSchedule): string[] {
  return [...schedule]
    .filter(([, entry]) => entry.due === task)
    .map(([ruleId]) => ruleId)
    .sort();
}
