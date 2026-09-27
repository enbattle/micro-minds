// Pure helpers for the harness integrity test (docs/dev-harness.md, principle 3: anything that
// can be checked without a model is checked in CI). They read nothing themselves; the test feeds
// them the repo's files.

/**
 * Built-in tool names that tool-event matchers may use. Source: the tool table in
 * https://code.claude.com/docs/en/tools-reference, checked against Claude Code 2.1.283.
 */
export const CLAUDE_CODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListAgents',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'ShareOnboardingGuide',
  'Skill',
  'SubagentHandback',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
]);

/** SessionStart matcher values (the `source` field). Source: https://code.claude.com/docs/en/hooks. */
export const SESSION_START_SOURCES: ReadonlySet<string> = new Set([
  'startup',
  'resume',
  'clear',
  'compact',
  'fork',
]);

/** Events whose matcher filters on `tool_name`. Source: https://code.claude.com/docs/en/hooks. */
export const TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
]);

export interface HookEntry {
  readonly event: string;
  /** The matcher group's matcher; undefined when omitted. */
  readonly matcher: string | undefined;
  readonly type: string | undefined;
  readonly command: string | undefined;
  readonly args: readonly string[];
  readonly timeout: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Flattens `settings.hooks` into one entry per hook handler. */
export function collectHooks(settings: unknown): HookEntry[] {
  const hooks = isRecord(settings) ? settings.hooks : undefined;
  if (!isRecord(hooks)) return [];
  const entries: HookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of asArray(groups)) {
      if (!isRecord(group)) continue;
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined;
      for (const handler of asArray(group.hooks)) {
        if (!isRecord(handler)) continue;
        entries.push({
          event,
          matcher,
          type: typeof handler.type === 'string' ? handler.type : undefined,
          command: typeof handler.command === 'string' ? handler.command : undefined,
          args: asArray(handler.args).filter((arg): arg is string => typeof arg === 'string'),
          timeout: typeof handler.timeout === 'number' ? handler.timeout : undefined,
        });
      }
    }
  }
  return entries;
}

const PROJECT_DIR_PREFIX = /\$\{CLAUDE_PROJECT_DIR\}[\\/]([^\s"']+)/g;

/** Project-relative paths a hook references through `${CLAUDE_PROJECT_DIR}/...`. */
export function projectPaths(entry: HookEntry): string[] {
  const text = [entry.command ?? '', ...entry.args].join(' ');
  return [...text.matchAll(PROJECT_DIR_PREFIX)].map((match) => match[1] ?? '');
}

/**
 * The exact names in a matcher, or null when Claude Code would treat it as a regular expression
 * (any character outside letters, digits, `_`, `-`, spaces, `,` and `|`). Empty and `*` match
 * everything and return [].
 */
export function matcherNames(matcher: string | undefined): string[] | null {
  if (matcher === undefined || matcher === '' || matcher === '*') return [];
  if (!/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return null;
  return matcher
    .split(/[|,]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** Problems with one hook's matcher for its event; empty when it's valid. */
export function matcherProblems(entry: HookEntry): string[] {
  const names = matcherNames(entry.matcher);
  const where = `${entry.event} matcher "${entry.matcher ?? ''}"`;
  if (names === null) return [`${where} is a regular expression; use exact names`];
  let allowed: ReadonlySet<string>;
  if (TOOL_EVENTS.has(entry.event)) {
    allowed = CLAUDE_CODE_TOOL_NAMES;
  } else if (entry.event === 'SessionStart') {
    allowed = SESSION_START_SOURCES;
  } else {
    return [`${entry.event} has no verified matcher list here: add one to integrity.ts`];
  }
  return names.filter((name) => !allowed.has(name)).map((name) => `${where}: unknown "${name}"`);
}

// ---------------------------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------------------------

export interface PermissionRule {
  readonly tool: string;
  readonly pattern: string;
  /** A `!pattern` carve-out that exempts paths from the tool's other deny rules. */
  readonly negated: boolean;
}

/** Parses `Tool(pattern)` and `Tool(!pattern)` rules; bare `Tool` rules are skipped. */
export function parsePermissionRules(rules: readonly string[]): PermissionRule[] {
  const parsed: PermissionRule[] = [];
  for (const rule of rules) {
    const match = /^([A-Za-z]+)\((!?)(.*)\)$/.exec(rule);
    if (match === null) continue;
    const [, tool = '', bang, pattern = ''] = match;
    parsed.push({ tool, pattern, negated: bang === '!' });
  }
  return parsed;
}

/** A gitignore-style path pattern (`**` any depth, `*` one segment) as an anchored regex. */
export function pathPatternToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === '*' && pattern.charAt(i + 1) === '*') {
      source += '.*';
      i++;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when the tool's deny rules match the path and no carve-out for that tool exempts it. */
export function deniedBySettings(
  tool: string,
  filePath: string,
  rules: readonly PermissionRule[],
): boolean {
  const forTool = rules.filter((rule) => rule.tool === tool);
  const matches = (rule: PermissionRule): boolean =>
    pathPatternToRegExp(rule.pattern).test(filePath);
  return (
    forTool.some((rule) => !rule.negated && matches(rule)) &&
    !forTool.some((rule) => rule.negated && matches(rule))
  );
}

/**
 * A shell-command rule pattern as an anchored regex. In `Bash(...)` and `PowerShell(...)` rules
 * `*` matches any characters, spaces included (https://code.claude.com/docs/en/permissions),
 * which is why a push allow rule needs deny rules for anything after the branch name.
 */
export function commandPatternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** Deny wins over allow; a command neither matches falls through to a prompt ("ask"). */
export function commandDecision(
  tool: string,
  command: string,
  allow: readonly PermissionRule[],
  deny: readonly PermissionRule[],
): 'allow' | 'deny' | 'ask' {
  const matches = (rule: PermissionRule): boolean =>
    rule.tool === tool && !rule.negated && commandPatternToRegExp(rule.pattern).test(command);
  if (deny.some(matches)) return 'deny';
  if (allow.some(matches)) return 'allow';
  return 'ask';
}

/** A concrete path a carve-out pattern matches: `**` → `sample/file.md`, `*` → a slug. */
export function representativePath(pattern: string): string {
  return pattern.replace(/\*\*/g, 'sample/file.md').replace(/\*/g, 'C--Users-alice-repo');
}

// ---------------------------------------------------------------------------------------------
// Frontmatter, hard rules, imports
// ---------------------------------------------------------------------------------------------

function unquote(value: string): string {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match?.[2] ?? value;
}

/**
 * Parses YAML frontmatter as flat `key: value` pairs, enough for agent and skill files: plain,
 * quoted, folded (`>`) and literal (`|`) scalars, and indented continuation lines. Nested
 * structures are kept as raw text. Returns null when the file has no frontmatter.
 */
export function parseFrontmatter(markdown: string): ReadonlyMap<string, string> | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) return null;

  const fields = new Map<string, string>();
  let key: string | undefined;
  let style: 'plain' | 'folded' | 'literal' = 'plain';
  let parts: string[] = [];
  const flush = (): void => {
    if (key === undefined) return;
    const joined = style === 'literal' ? parts.join('\n') : parts.join(' ');
    fields.set(key, style === 'plain' ? unquote(joined.trim()) : joined.trim());
  };

  for (const line of lines.slice(1, end)) {
    const field = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (field !== null) {
      flush();
      key = field[1];
      const value = (field[2] ?? '').trim();
      style = /^>[-+]?$/.test(value) ? 'folded' : /^\|[-+]?$/.test(value) ? 'literal' : 'plain';
      parts = style === 'plain' && value.length > 0 ? [value] : [];
    } else if (key !== undefined && /^\s/.test(line)) {
      parts.push(line.trim());
    }
  }
  flush();
  return fields;
}

/** The item numbers of the ordered list in CLAUDE.md's "Hard rules" section. */
export function hardRuleNumbers(claudeMd: string): number[] {
  const start = claudeMd.search(/^## Hard rules\b/m);
  if (start === -1) return [];
  const rest = claudeMd.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  return [...section.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
}

/** Problems when `numbers` isn't exactly 1, 2, ..., N. */
export function numberingProblems(numbers: readonly number[]): string[] {
  if (numbers.length === 0) return ['no numbered hard rules found'];
  return numbers.flatMap((n, i) =>
    n === i + 1 ? [] : [`hard rule at position ${i + 1} is numbered ${n}`],
  );
}

/** The k of every `HR<k>-...` rule id. */
export function hardRuleIdNumbers(catalog: readonly string[]): Set<number> {
  const numbers = new Set<number>();
  for (const id of catalog) {
    const match = /^HR(\d+)-/.exec(id);
    if (match !== null) numbers.add(Number(match[1]));
  }
  return numbers;
}

/**
 * True when `source` statically imports (or re-exports from) a module whose specifier ends with
 * `/<pathSuffix>`, for example `.claude/hooks/guard.ts`.
 */
export function importsModule(source: string, pathSuffix: string): boolean {
  const suffix = `/${pathSuffix.replace(/\\/g, '/')}`;
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].some((match) =>
    (match[1] ?? '').replace(/[\\/]+/g, '/').endsWith(suffix),
  );
}
