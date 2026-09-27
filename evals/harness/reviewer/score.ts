// Pure parsing and scoring for the reviewer evals (PLAN §11.1). No I/O here, so every
// function is unit-tested in score.test.ts; run.ts does the process and file work.

import { extractModels } from './versions.ts';

export const SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERDICTS = ['approve', 'changes_requested'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Minimum share of planted violations the reviewer must find across all cases. */
export const RECALL_THRESHOLD = 0.8;

export interface Finding {
  ruleId: string;
  severity: Severity;
  file: string;
  line: number | null;
  summary: string;
  /** False for a problem the change didn't cause; such findings never block (ADR 0028). */
  introduced: boolean;
}

export interface ReviewOutput {
  findings: Finding[];
  /** What the reviewer tried in order to break the change; never empty (ADR 0028). */
  probed: string[];
  /** The change adds or alters an external surface, so the caller runs the security pass. */
  externalSurface: boolean;
  verdict: Verdict;
}

export interface Expected {
  mustFind: string[];
  mustNotFind: string[];
  notes: string;
}

export interface ClaudeResult {
  resultText: string;
  isError: boolean;
  subtype: string;
  costUsd: number | null;
  numTurns: number | null;
  /** Model ids from `modelUsage` (see versions.ts); empty when the result doesn't say. */
  models: string[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CaseScore {
  name: string;
  /** A clean case has no planted violations; any blocker/major finding is a false positive. */
  clean: boolean;
  status: 'scored' | 'error';
  error?: string;
  mustFind: string[];
  found: string[];
  missed: string[];
  /** mustNotFind rule ids the reviewer reported anyway, at any severity. */
  forbiddenHits: string[];
  /** Blocker/major findings on a clean case. */
  falsePositives: Finding[];
  /** Rule ids the reviewer used that aren't in the agent's catalog. */
  unknownRuleIds: string[];
  verdict: Verdict | null;
  /** approve on a clean case, changes_requested on a planted one. */
  verdictAsExpected: boolean;
  findingCount: number;
}

export interface Summary {
  cases: number;
  errors: number;
  mustFindTotal: number;
  mustFindFound: number;
  recall: number;
  threshold: number;
  forbiddenHits: number;
  cleanCasesWithFalsePositives: number;
  passed: boolean;
  reasons: string[];
}

const RULE_ID_PATTERN = /^[A-Z][A-Z0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATALOG_ROW_PATTERN = /^\|\s*`([A-Z][A-Z0-9]*-[a-z0-9-]+)`\s*\|/gm;
const JSON_FENCE_PATTERN = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Rule ids compare case-insensitively and ignore surrounding whitespace. */
export function normalizeRuleId(ruleId: string): string {
  return ruleId.trim().toLowerCase();
}

/** Every rule id defined in a catalog table row (`| \`HR3-localhost-bind\` | …`) of reviewer.md. */
export function extractRuleCatalog(markdown: string): string[] {
  const ids = new Set<string>();
  for (const match of markdown.matchAll(CATALOG_ROW_PATTERN)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/** The body of the last ```json fenced block, which the reviewer's contract puts at the end. */
export function extractFinalJsonBlock(text: string): string | undefined {
  let last: string | undefined;
  for (const match of text.matchAll(JSON_FENCE_PATTERN)) {
    last = match[1];
  }
  return last;
}

function parseFinding(value: unknown, index: number): Parsed<Finding> {
  const where = `findings[${index}]`;
  if (!isRecord(value)) return { ok: false, error: `${where} is not an object` };
  const { ruleId, severity, file, line, summary } = value;
  if (typeof ruleId !== 'string' || ruleId.trim() === '') {
    return { ok: false, error: `${where}.ruleId must be a non-empty string` };
  }
  if (!isOneOf(SEVERITIES, severity)) {
    return { ok: false, error: `${where}.severity must be one of ${SEVERITIES.join(', ')}` };
  }
  if (typeof file !== 'string') return { ok: false, error: `${where}.file must be a string` };
  if (line !== null && !(typeof line === 'number' && Number.isInteger(line) && line >= 0)) {
    return { ok: false, error: `${where}.line must be a non-negative integer or null` };
  }
  if (typeof summary !== 'string') return { ok: false, error: `${where}.summary must be a string` };
  const { introduced = true } = value;
  if (typeof introduced !== 'boolean') {
    return { ok: false, error: `${where}.introduced must be a boolean when present` };
  }
  return { ok: true, value: { ruleId: ruleId.trim(), severity, file, line, summary, introduced } };
}

/** `probed`: a non-empty array of non-blank strings, kept as given. */
function parseProbed(value: unknown): Parsed<string[]> {
  const valid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item): item is string => typeof item === 'string' && item.trim() !== '');
  if (!valid) {
    return { ok: false, error: '"probed" must be a non-empty array of non-blank strings' };
  }
  return { ok: true, value: [...value] };
}

/** Parses the reviewer's final ```json block into findings and a verdict. */
export function parseReviewOutput(text: string): Parsed<ReviewOutput> {
  const block = extractFinalJsonBlock(text);
  if (block === undefined) return { ok: false, error: 'no ```json block in the reviewer output' };
  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `final json block is not valid JSON: ${message}` };
  }
  if (!isRecord(data)) return { ok: false, error: 'final json block is not an object' };
  if (!Array.isArray(data.findings)) return { ok: false, error: '"findings" must be an array' };
  if (!isOneOf(VERDICTS, data.verdict)) {
    return { ok: false, error: `"verdict" must be one of ${VERDICTS.join(', ')}` };
  }
  const findings: Finding[] = [];
  for (const [index, item] of data.findings.entries()) {
    const finding = parseFinding(item, index);
    if (!finding.ok) return finding;
    findings.push(finding.value);
  }
  const probed = parseProbed(data.probed);
  if (!probed.ok) return probed;
  const { externalSurface = false } = data;
  if (typeof externalSurface !== 'boolean') {
    return { ok: false, error: '"externalSurface" must be a boolean when present' };
  }
  return {
    ok: true,
    value: { findings, probed: probed.value, externalSurface, verdict: data.verdict },
  };
}

/** Parses the single JSON object printed by `claude -p --output-format json`. */
export function parseClaudeJson(stdout: string): Parsed<ClaudeResult> {
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      error: 'claude stdout is not a JSON object (was --output-format json used?)',
    };
  }
  if (!isRecord(data) || data.type !== 'result') {
    return { ok: false, error: 'claude stdout is not a "result" message' };
  }
  const subtype = typeof data.subtype === 'string' ? data.subtype : 'unknown';
  return {
    ok: true,
    value: {
      resultText: typeof data.result === 'string' ? data.result : '',
      isError: data.is_error === true || subtype !== 'success',
      subtype,
      costUsd: typeof data.total_cost_usd === 'number' ? data.total_cost_usd : null,
      numTurns: typeof data.num_turns === 'number' ? data.num_turns : null,
      models: extractModels(data),
    },
  };
}

/** Validates an expected.json value. Rule ids must exist in the reviewer's catalog. */
export function parseExpected(value: unknown, catalog: readonly string[]): Parsed<Expected> {
  if (!isRecord(value)) return { ok: false, error: 'expected.json must be an object' };
  const { mustFind, mustNotFind, notes } = value;
  if (!isStringArray(mustFind)) return { ok: false, error: '"mustFind" must be a string array' };
  if (!isStringArray(mustNotFind)) {
    return { ok: false, error: '"mustNotFind" must be a string array' };
  }
  if (typeof notes !== 'string' || notes.trim() === '') {
    return { ok: false, error: '"notes" must be a non-empty string' };
  }
  const known = new Set(catalog.map(normalizeRuleId));
  for (const id of [...mustFind, ...mustNotFind]) {
    if (!RULE_ID_PATTERN.test(id)) return { ok: false, error: `malformed rule id "${id}"` };
    if (!known.has(normalizeRuleId(id))) {
      return { ok: false, error: `rule id "${id}" is not in the reviewer catalog` };
    }
  }
  const must = new Set(mustFind.map(normalizeRuleId));
  const overlap = mustNotFind.filter((id) => must.has(normalizeRuleId(id)));
  if (overlap.length > 0) {
    return { ok: false, error: `rule ids in both mustFind and mustNotFind: ${overlap.join(', ')}` };
  }
  return { ok: true, value: { mustFind, mustNotFind, notes } };
}

/** Cheap structural check that a case's change.diff is a unified diff. */
export function checkUnifiedDiff(diff: string): Parsed<{ files: string[] }> {
  const files = [...diff.matchAll(/^\+\+\+ b\/(\S+)$/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
  if (files.length === 0) return { ok: false, error: 'no "+++ b/<path>" file headers' };
  if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(diff)) {
    return { ok: false, error: 'no "@@ -a,b +c,d @@" hunk headers' };
  }
  return { ok: true, value: { files } };
}

function baseScore(name: string, expected: Expected): CaseScore {
  return {
    name,
    clean: expected.mustFind.length === 0,
    status: 'scored',
    mustFind: [...expected.mustFind],
    found: [],
    missed: [],
    forbiddenHits: [],
    falsePositives: [],
    unknownRuleIds: [],
    verdict: null,
    verdictAsExpected: false,
    findingCount: 0,
  };
}

/** A case whose review couldn't be obtained or parsed: every planted violation counts as missed. */
export function scoreErroredCase(name: string, expected: Expected, error: string): CaseScore {
  return { ...baseScore(name, expected), status: 'error', error, missed: [...expected.mustFind] };
}

export function scoreCase(
  name: string,
  expected: Expected,
  review: ReviewOutput,
  catalog: readonly string[],
): CaseScore {
  const reported = new Set(review.findings.map((f) => normalizeRuleId(f.ruleId)));
  const known = new Set(catalog.map(normalizeRuleId));
  const score = baseScore(name, expected);
  score.found = expected.mustFind.filter((id) => reported.has(normalizeRuleId(id)));
  score.missed = expected.mustFind.filter((id) => !reported.has(normalizeRuleId(id)));
  score.forbiddenHits = expected.mustNotFind.filter((id) => reported.has(normalizeRuleId(id)));
  score.falsePositives = score.clean
    ? review.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major')
    : [];
  score.unknownRuleIds = [
    ...new Set(
      review.findings.map((f) => f.ruleId).filter((id) => !known.has(normalizeRuleId(id))),
    ),
  ];
  score.verdict = review.verdict;
  score.verdictAsExpected = review.verdict === (score.clean ? 'approve' : 'changes_requested');
  score.findingCount = review.findings.length;
  return score;
}

export function summarize(scores: readonly CaseScore[], threshold = RECALL_THRESHOLD): Summary {
  const mustFindTotal = scores.reduce((n, s) => n + s.mustFind.length, 0);
  const mustFindFound = scores.reduce((n, s) => n + s.found.length, 0);
  const recall = mustFindTotal === 0 ? 1 : mustFindFound / mustFindTotal;
  const errors = scores.filter((s) => s.status === 'error').length;
  const forbiddenHits = scores.reduce((n, s) => n + s.forbiddenHits.length, 0);
  const cleanCasesWithFalsePositives = scores.filter(
    (s) => s.clean && s.falsePositives.length > 0,
  ).length;

  const reasons: string[] = [];
  if (recall < threshold) {
    reasons.push(`recall ${formatRatio(recall)} is below the ${formatRatio(threshold)} threshold`);
  }
  if (cleanCasesWithFalsePositives > 0) {
    reasons.push(`${cleanCasesWithFalsePositives} clean case(s) got blocker/major findings`);
  }
  if (forbiddenHits > 0) reasons.push(`${forbiddenHits} mustNotFind rule(s) reported`);
  if (errors > 0) reasons.push(`${errors} case(s) errored`);

  return {
    cases: scores.length,
    errors,
    mustFindTotal,
    mustFindFound,
    recall,
    threshold,
    forbiddenHits,
    cleanCasesWithFalsePositives,
    passed: reasons.length === 0,
    reasons,
  };
}

export function formatRatio(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** One run of a case passes when it scored, found every planted rule and reported nothing it mustn't. */
export function casePassed(score: CaseScore): boolean {
  return (
    score.status === 'scored' &&
    score.missed.length === 0 &&
    score.forbiddenHits.length === 0 &&
    score.falsePositives.length === 0
  );
}

function caseResult(score: CaseScore): string {
  if (score.status === 'error') return 'ERROR';
  return casePassed(score) ? 'PASS' : 'FAIL';
}

/** Plain-text table for the terminal, one row per case plus a totals line. */
export function formatSummaryTable(scores: readonly CaseScore[], summary: Summary): string {
  const header = ['case', 'type', 'found', 'missed', 'forbidden', 'false+', 'verdict', 'result'];
  const rows = scores.map((s) => [
    s.name,
    s.clean ? 'clean' : 'planted',
    s.clean ? '-' : `${s.found.length}/${s.mustFind.length}`,
    s.missed.join(' ') || '-',
    s.forbiddenHits.join(' ') || '-',
    s.clean ? String(s.falsePositives.length) : '-',
    s.verdict === null ? '-' : `${s.verdict}${s.verdictAsExpected ? '' : ' (!)'}`,
    caseResult(s),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const totals =
    `recall ${summary.mustFindFound}/${summary.mustFindTotal} = ${formatRatio(summary.recall)} ` +
    `(threshold ${formatRatio(summary.threshold)}), clean cases with false positives: ` +
    `${summary.cleanCasesWithFalsePositives}, forbidden hits: ${summary.forbiddenHits}, ` +
    `errors: ${summary.errors} -> ${summary.passed ? 'PASS' : 'FAIL'}`;
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), '', totals].join(
    '\n',
  );
}
