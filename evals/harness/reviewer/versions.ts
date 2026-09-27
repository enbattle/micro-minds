// Which Claude Code build and which model produced a reviewer eval run. Pure, so the parsing
// of `claude --version` and of the `claude -p --output-format json` result is unit-tested.
//
// The result message carries `modelUsage`, "a map of model name to per-model token counts and
// cost" (https://code.claude.com/docs/en/agent-sdk/cost-tracking, SDKResultMessage). Each entry
// has `costUSD`, `inputTokens`, `outputTokens`, ... . It includes subagent and helper-model
// requests, so a run can list more than one model; the costliest comes first.

export const UNKNOWN = 'unknown';

const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The semver-ish token in `claude --version` output (`2.1.283 (Claude Code)`), or `unknown`. */
export function parseClaudeVersion(stdout: string): string {
  return VERSION_PATTERN.exec(stdout)?.[1] ?? UNKNOWN;
}

function costOf(entry: unknown): number {
  if (!isRecord(entry)) return 0;
  return typeof entry.costUSD === 'number' && Number.isFinite(entry.costUSD) ? entry.costUSD : 0;
}

/**
 * Model ids from a parsed result message: the keys of `modelUsage`, costliest first (ties by
 * name), falling back to a top-level `model` string. Empty when neither is present.
 */
export function extractModels(result: unknown): string[] {
  if (!isRecord(result)) return [];
  const usage = result.modelUsage;
  if (isRecord(usage)) {
    const models = Object.entries(usage)
      .filter(([id]) => id.trim() !== '')
      .sort(([a, ea], [b, eb]) => costOf(eb) - costOf(ea) || a.localeCompare(b))
      .map(([id]) => id.trim());
    if (models.length > 0) return models;
  }
  return typeof result.model === 'string' && result.model.trim() !== ''
    ? [result.model.trim()]
    : [];
}

/** Distinct model ids across trials, first-seen order; `unknown` when none was determined. */
export function distinctModels(perTrial: readonly (readonly string[])[]): string[] {
  const seen = [...new Set(perTrial.flat().filter((id) => id !== UNKNOWN))];
  return seen.length > 0 ? seen : [UNKNOWN];
}

/** How to name the reviewer model in a report, noting the --model flag when one was passed. */
export function describeModels(models: readonly string[], modelFlag: string | undefined): string {
  const known = models.filter((id) => id !== UNKNOWN);
  const named = known.length > 0 ? known.join(', ') : UNKNOWN;
  return modelFlag === undefined ? named : `${named} (--model ${modelFlag})`;
}
