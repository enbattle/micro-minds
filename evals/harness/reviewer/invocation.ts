// How the reviewer agent is invoked headlessly. Pure, so the exact argv and prompt are tested.
// Flags verified against Claude Code 2.1.283 (`claude --help`) and
// https://code.claude.com/docs/en/cli-reference, /headless and /sub-agents.

export interface InvocationOptions {
  maxTurns: number;
  maxBudgetUsd: number;
  model: string | undefined;
}

export const DEFAULT_INVOCATION: InvocationOptions = {
  maxTurns: 12,
  maxBudgetUsd: 1,
  model: undefined,
};

/** The reviewer only needs to read; the agent file allows the same three tools. */
export const REVIEWER_TOOLS = 'Read,Grep,Glob';

const SAFE_ARG = /^[A-Za-z0-9._,-]+$/;

/**
 * argv for `claude`. The prompt and diff go through stdin, never argv, which avoids the Windows
 * command-line length limit and all quoting. Every argument here matches SAFE_ARG, so the argv
 * stays safe even when a `.cmd` shim forces `shell: true`.
 */
export function buildClaudeArgs(options: InvocationOptions): string[] {
  const args = [
    '-p',
    // Run the whole session as the reviewer agent: its body is the system prompt, its tools apply.
    '--agent',
    'reviewer',
    '--output-format',
    'json',
    // Deny anything that would prompt; reads inside the repo need no approval.
    '--permission-mode',
    'dontAsk',
    // Belt and braces on top of the agent's `tools:` line: only read-only built-ins exist.
    '--tools',
    REVIEWER_TOOLS,
    '--max-turns',
    String(options.maxTurns),
    '--max-budget-usd',
    String(options.maxBudgetUsd),
    '--no-session-persistence',
    // Reproducible runs: project settings only (no user hooks/plugins), no MCP servers.
    '--setting-sources',
    'project',
    '--strict-mcp-config',
  ];
  if (options.model !== undefined) args.push('--model', options.model);
  const unsafe = args.filter((arg) => !SAFE_ARG.test(arg));
  if (unsafe.length > 0) throw new Error(`refusing unsafe claude argument(s): ${unsafe.join(' ')}`);
  return args;
}

/** The stdin prompt: fixed instructions, then the diff in a fence the reviewer can't confuse. */
export function buildPrompt(diff: string): string {
  const fence = diff.includes('````') ? '``````' : '````';
  return [
    'Review the following change to the micro-minds repository.',
    '',
    'It is a proposed change: the files it touches may not exist on disk, so judge the diff as',
    'written. You may read CLAUDE.md, docs/PLAN.md and other repo files for context. Assume each',
    "workspace's package.json already declares the packages the diff imports, unless the diff",
    'itself changes a package.json. The diff is an excerpt: relative modules it imports but does',
    'not include (for example a helper or a test fake) exist, are tested elsewhere, and behave as',
    'their names and call sites suggest. Review only the code shown.',
    '',
    'Follow your output contract exactly and end with the json block.',
    '',
    `${fence}diff`,
    diff.trimEnd(),
    fence,
    '',
  ].join('\n');
}

/** How to show the command in --dry-run output. */
export function formatCommand(binary: string, args: readonly string[]): string {
  const quote = (s: string): string => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return [binary, ...args].map(quote).join(' ');
}
