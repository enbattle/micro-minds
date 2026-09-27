// PreToolUse guard (PLAN task 0.6, CLAUDE.md hard rule 1). Defense in depth on top of the deny
// rules in .claude/settings.json: those match the command text Claude writes, so they miss
// forms like `cat "$HOME"/.claude/x`, `Get-Content $env:USERPROFILE\.codex\auth.json` or
// `cat ../../.claude/x`. This guard resolves every path-like token and compares it against the
// real home directory.
//
// It is a heuristic, not a sandbox: it cannot see paths that a script builds at runtime.
//
// Contract (verified against https://code.claude.com/docs/en/hooks):
// - stdin: the PreToolUse payload ({ tool_name, tool_input, cwd, ... }).
// - deny: decision JSON on stdout, the reason on stderr, exit code 2. Exit 2 blocks even if a
//   Claude Code version fails to parse the JSON; when the JSON is valid its reason is used.
// - allow: no output, exit 0, so the normal permission flow (rules, prompts) still applies.
// - malformed input: allow (a broken guard must not brick Claude Code) with a note on stderr.

import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export type GuardContext = {
  readonly homeDir: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
};

export type Decision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string };

export type ToolCall = {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd: string | undefined;
};

export const REASONS = {
  homeConfig:
    "micro-minds guard: ~/.claude, ~/.gemini and ~/.codex are off-limits (CLAUDE.md hard rule 1). Use the project's own .claude/ directory instead.",
  homeRecursive:
    'micro-minds guard: recursive access to the home directory (or above) would reach ~/.claude, ~/.gemini or ~/.codex. Narrow the path to the project.',
  envFile:
    'micro-minds guard: .env files may hold secrets (CLAUDE.md hard rule 1). Use .env.example, or ask the user for the specific non-secret value.',
  envDump:
    'micro-minds guard: dumping the whole environment can leak tokens. Read one specific, non-secret variable instead.',
} as const;

const PROTECTED_DIR_NAMES = ['.claude', '.gemini', '.codex'] as const;
const ALLOWED_ENV_SUFFIXES: ReadonlySet<string> = new Set(['example', 'sample', 'template']);
// Names a glob is tested against to decide whether it could expand to a real .env file.
const ENV_FILE_PROBES = ['.env', '.env.local', '.env.production'] as const;
// Commands that walk directory trees even without a recursive flag.
const RECURSIVE_COMMANDS: ReadonlySet<string> = new Set([
  'find',
  'rg',
  'fd',
  'ag',
  'tree',
  'du',
  'tar',
  'zip',
  '7z',
  'robocopy',
  'xcopy',
]);
const ENV_DUMP_COMMANDS: ReadonlySet<string> = new Set(['env', 'printenv']);
const SHELL_VAR_LISTERS: ReadonlySet<string> = new Set(['export', 'declare', 'typeset']);

const FILE_PATH_FIELDS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

// Every spelling of "the home directory" at the start of a token, across POSIX shells, Git Bash,
// cmd and PowerShell. The lookahead stops `$HOME` from matching `$HOMEPATH`.
const HOME_PREFIX =
  /^(?:~|\$\{HOME\}|\$HOME|%HOMEDRIVE%%HOMEPATH%|%USERPROFILE%|%HOME%|\$env:HOMEDRIVE\$env:HOMEPATH|\$\{env:USERPROFILE\}|\$\{env:HOME\}|\$env:USERPROFILE|\$env:HOME)(?=[\\/]|$)/i;
// Git Bash / MSYS / Cygwin / WSL spellings of a Windows drive root: /c/..., /cygdrive/c/..., /mnt/c/...
const POSIX_DRIVE_PREFIX = /^\/(?:cygdrive\/|mnt\/)?([a-z])(?=\/|$)/i;
// PowerShell's env: drive (listing it dumps every variable); `env:PATH` (one variable) is fine.
const ENV_DRIVE = /^env:[\\/]?\*?$/i;
const RECURSIVE_FLAG = /^(?:-[a-z]*r[a-z]*|--recursive)$/i;
const DOTNET_ENV_DUMP = /GetEnvironmentVariables\s*\(/i;

const ALLOW: Decision = { decision: 'allow' };
const deny = (reason: string): Decision => ({ decision: 'deny', reason });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Narrows a raw hook payload. Returns null when it isn't a recognizable tool call. */
export function parseToolCall(input: unknown): ToolCall | null {
  if (!isRecord(input)) return null;
  const toolName = stringField(input, 'tool_name');
  const toolInput = input.tool_input;
  if (toolName === undefined || !isRecord(toolInput)) return null;
  return { toolName, toolInput, cwd: stringField(input, 'cwd') };
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

// Windows and default macOS volumes are case-insensitive.
function foldCase(platform: NodeJS.Platform): (s: string) => string {
  return platform === 'win32' || platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;
}

function hasGlob(segment: string): boolean {
  return /[*?[]/.test(segment);
}

/** Converts one path segment's shell glob (`*`, `?`, `[...]`, `[!...]`) to an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === '*') {
      source += '[^/\\\\]*';
    } else if (char === '?') {
      source += '[^/\\\\]';
    } else if (char === '[' && glob.indexOf(']', i + 2) !== -1) {
      const end = glob.indexOf(']', i + 2);
      const body = glob
        .slice(i + 1, end)
        .replace(/^!/, '^')
        .replace(/\\/g, '\\\\');
      source += `[${body}]`;
      i = end;
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

function segmentMatches(segment: string, name: string, fold: (s: string) => string): boolean {
  return hasGlob(segment) ? globToRegExp(segment).test(name) : fold(segment) === fold(name);
}

function isProtectedDirName(segment: string): boolean {
  // Always case-insensitive: a false positive here only blocks `~/.CLAUDE` on Linux.
  return PROTECTED_DIR_NAMES.some((name) => segmentMatches(segment, name, (s) => s.toLowerCase()));
}

/** True for `.env` and `.env.<anything>` (or a dot-glob that could expand to one), except templates. */
export function isEnvFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (hasGlob(lower)) {
    // Only dot-globs: `*` alone would match `.env` in theory but in practice means "all files".
    if (!lower.startsWith('.')) return false;
    const pattern = globToRegExp(lower);
    return ENV_FILE_PROBES.some((probe) => pattern.test(probe));
  }
  const match = /^\.env(?:\.(.+))?$/.exec(lower);
  if (match === null) return false;
  const suffix = match[1];
  return suffix === undefined || !ALLOWED_ENV_SUFFIXES.has(suffix);
}

function basename(token: string): string {
  const parts = token.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.at(-1) ?? '';
}

/** Replaces a leading home-directory reference (`~`, `$HOME`, `%USERPROFILE%`, ...) with homeDir. */
export function expandHome(token: string, homeDir: string): string {
  const match = HOME_PREFIX.exec(token);
  return match === null ? token : homeDir + token.slice(match[0].length);
}

function isBareHomeReference(token: string): boolean {
  const match = HOME_PREFIX.exec(token);
  return match !== null && /^[\\/]*$/.test(token.slice(match[0].length));
}

/** Resolves a path-like token to an absolute path in the target platform's flavor. */
export function resolveToken(token: string, base: string, ctx: GuardContext): string | null {
  if (token.length === 0 || token.includes('://')) return null;
  let expanded = expandHome(token, ctx.homeDir);
  if (ctx.platform === 'win32') {
    expanded = expanded.replace(POSIX_DRIVE_PREFIX, (_, drive: string) => `${drive}:`);
    // A bare drive (`C:`) means "cwd on that drive" to Windows; treat it as the drive root.
    if (/^[a-z]:$/i.test(expanded)) expanded += '\\';
  }
  return pathApi(ctx.platform).resolve(base, expanded);
}

export type PathClass = 'home-config' | 'home-or-ancestor' | 'other';

/**
 * Classifies an absolute path relative to the home directory. Glob segments are treated as
 * "could match", so `~/.c*` and `/c/Users/*` are caught, and `**` above the config dirs counts as
 * reaching them.
 */
export type Access = 'read' | 'write';

export function classifyPath(
  absolute: string,
  ctx: GuardContext,
  access: Access = 'read',
): PathClass {
  const fold = foldCase(ctx.platform);
  const split = (p: string): string[] => p.split(/[\\/]+/).filter((s) => s.length > 0);
  const home = split(pathApi(ctx.platform).resolve(ctx.homeDir));
  const target = split(absolute);

  for (const [i, homeSegment] of home.entries()) {
    const segment = target[i];
    if (segment === undefined) return 'home-or-ancestor';
    if (segment === '**') return 'home-config';
    if (!segmentMatches(segment, homeSegment, fold)) return 'other';
  }
  const next = target[home.length];
  if (next === undefined) return 'home-or-ancestor';
  if (!isProtectedDirName(next)) return 'other';
  return isClaudeWorkingFile(next, target.slice(home.length + 1), access) ? 'other' : 'home-config';
}

/**
 * Claude Code keeps some of its own working files under ~/.claude and reads them back with the
 * file tools: plans (plan mode), per-project auto-memory, and large tool outputs. Blocking them
 * breaks those features without protecting anything secret, so they are exempt (decision made
 * with the repo owner during Phase 0). Every segment must be literal: a glob could widen the
 * match to credentials or session transcripts. Tool results are read-only, matching the deny
 * rules in .claude/settings.json (ADR 0024); plans and memory are also written.
 */
function isClaudeWorkingFile(configDir: string, rest: readonly string[], access: Access): boolean {
  if (configDir.toLowerCase() !== '.claude' || rest.some(hasGlob)) return false;
  const [first, slug, area] = rest;
  if (first === 'plans') return true;
  if (first !== 'projects' || slug === undefined) return false;
  return area === 'memory' || (area === 'tool-results' && access === 'read');
}

/** File tools that modify their target. Shell commands count as reads (the guard can't tell). */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function checkPath(
  raw: string,
  base: string,
  ctx: GuardContext,
  access: Access = 'read',
): Decision {
  const absolute = resolveToken(raw, base, ctx);
  if (absolute !== null && classifyPath(absolute, ctx, access) === 'home-config') {
    return deny(REASONS.homeConfig);
  }
  return isEnvFileName(basename(raw)) ? deny(REASONS.envFile) : ALLOW;
}

// ---------------------------------------------------------------------------------------------
// Shell commands (Bash and PowerShell)
// ---------------------------------------------------------------------------------------------

/** Splits a command line into simple commands on shell separators and subshell boundaries. */
export function splitSubcommands(command: string): string[] {
  return command
    .split(/\r?\n|&&|\|\||\$\(|[;|&()]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Splits a simple command into words. Quotes and backticks (PowerShell's escape character) are
 * removed so `"$HOME"/.claude` and `.cl`aude` are seen as one word; `=`, `,`, `<` and `>` also
 * separate words so `--env-file=.env` and `<.env` expose the path.
 */
export function tokenize(subcommand: string): string[] {
  return subcommand
    .split(/[\s<>,=]+/)
    .map((token) => token.replace(/["'`]/g, ''))
    .filter((token) => token.length > 0);
}

function isFlag(token: string): boolean {
  return token.startsWith('-');
}

function isEnvDump(tokens: readonly string[]): boolean {
  const [first, ...rest] = tokens;
  if (first === undefined) return false;
  const command = first.toLowerCase();
  if (ENV_DUMP_COMMANDS.has(command)) return rest.every(isFlag);
  // `set` alone lists every variable in bash and cmd; `set -e` / `set -o pipefail` do not.
  if (command === 'set') return rest.length === 0;
  if (SHELL_VAR_LISTERS.has(command)) return rest.every(isFlag);
  return tokens.some((token) => ENV_DRIVE.test(token));
}

function decideCommand(command: string, base: string, ctx: GuardContext): Decision {
  if (DOTNET_ENV_DUMP.test(command)) return deny(REASONS.envDump);

  const subcommands = splitSubcommands(command).map(tokenize);
  const tokens = subcommands.flat();

  for (const token of tokens) {
    const decision = checkPath(token, base, ctx);
    if (decision.decision === 'deny') return decision;
  }

  // `cd ~ && cat .claude/x`, `Join-Path $HOME .codex`: a bare home reference plus a relative
  // path that starts with a config dir name.
  const mentionsHome = tokens.some(isBareHomeReference);
  const startsWithConfigDir = (token: string): boolean => {
    const first = token.split(/[\\/]+/)[0];
    return first !== undefined && isProtectedDirName(first);
  };
  if (mentionsHome && tokens.some(startsWithConfigDir)) return deny(REASONS.homeConfig);

  const isRecursive =
    tokens.some((token) => RECURSIVE_FLAG.test(token)) ||
    subcommands.some((words) => RECURSIVE_COMMANDS.has((words[0] ?? '').toLowerCase()));
  if (isRecursive) {
    const reachesHome = tokens.some((token) => {
      const absolute = resolveToken(token, base, ctx);
      return absolute !== null && classifyPath(absolute, ctx) === 'home-or-ancestor';
    });
    if (reachesHome) return deny(REASONS.homeRecursive);
  }

  return subcommands.some(isEnvDump) ? deny(REASONS.envDump) : ALLOW;
}

// ---------------------------------------------------------------------------------------------
// Search tools (Grep and Glob): both walk directory trees
// ---------------------------------------------------------------------------------------------

function decideSearch(call: ToolCall, base: string, ctx: GuardContext): Decision {
  const searchRoot = stringField(call.toolInput, 'path');
  let root = base;
  if (searchRoot !== undefined) {
    const decision = checkPath(searchRoot, base, ctx);
    if (decision.decision === 'deny') return decision;
    const absolute = resolveToken(searchRoot, base, ctx);
    if (absolute !== null && classifyPath(absolute, ctx) === 'home-or-ancestor') {
      return deny(REASONS.homeRecursive);
    }
    root = absolute ?? base;
  }

  if (call.toolName === 'Glob') {
    const pattern = stringField(call.toolInput, 'pattern');
    return pattern === undefined ? ALLOW : checkPath(pattern, root, ctx);
  }
  const glob = stringField(call.toolInput, 'glob');
  return glob !== undefined && isEnvFileName(basename(glob)) ? deny(REASONS.envFile) : ALLOW;
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/** Pure decision for one PreToolUse payload. Unrecognized input is allowed. */
export function decide(input: unknown, ctx: GuardContext): Decision {
  const call = parseToolCall(input);
  if (call === null) return ALLOW;

  const api = pathApi(ctx.platform);
  // The payload's cwd is the session's real working directory (it differs in worktrees).
  const base = call.cwd !== undefined && api.isAbsolute(call.cwd) ? call.cwd : ctx.cwd;

  if (SHELL_TOOLS.has(call.toolName)) {
    const command = stringField(call.toolInput, 'command');
    return command === undefined ? ALLOW : decideCommand(command, base, ctx);
  }
  if (call.toolName === 'Grep' || call.toolName === 'Glob') {
    return decideSearch(call, base, ctx);
  }
  const field = FILE_PATH_FIELDS[call.toolName];
  const filePath = field === undefined ? undefined : stringField(call.toolInput, field);
  const access: Access = WRITE_TOOLS.has(call.toolName) ? 'write' : 'read';
  return filePath === undefined ? ALLOW : checkPath(filePath, base, ctx, access);
}

/** The stdout payload that tells Claude Code to block the tool call. */
export function formatDenyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/* v8 ignore start -- process entry point: covered by the subprocess tests in evals/harness/guard, which v8 cannot instrument. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<unknown>) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function note(message: string): void {
  process.stderr.write(`micro-minds guard: ${message}; allowing\n`);
}

async function main(): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    note('stdin is not valid JSON');
    return;
  }
  if (parseToolCall(input) === null) {
    note('unrecognized PreToolUse payload');
    return;
  }

  const decision = decide(input, {
    homeDir: os.homedir(),
    cwd: process.cwd(),
    platform: process.platform,
  });
  if (decision.decision === 'deny') {
    process.stdout.write(`${formatDenyOutput(decision.reason)}\n`);
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    note(`internal error (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 0;
  }
}
/* v8 ignore stop */
