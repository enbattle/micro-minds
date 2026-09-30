// The provider registry (D10): looks adapters up by id, resolves their binaries on PATH, maps
// tool names to categories, and wraps normalize() so whatever an adapter returns is safe to store
// and broadcast (hard rules 7 and 8).
import path from 'node:path';
import {
  type AgentEvent,
  EVENT_SCHEMA_VERSION,
  type Provider,
  parseAgentEvent,
  scrubRaw,
  scrubText,
  type ToolCategory,
} from '@micro-minds/shared';
import type { NormalizeContext, ProviderAdapter } from './types.ts';

/** The largest serialized `raw` kept per event (D14). */
export const RAW_MAX_LENGTH = 64 * 1024;

/** Windows' own default when PATHEXT is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** A bare command name: no separator, no `..`, no drive or extension games. */
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface BinaryLookup {
  platform: NodeJS.Platform;
  /** The PATH value. */
  path: string;
  /** PATHEXT, on Windows. */
  pathExt?: string;
  isFile: (absolutePath: string) => boolean;
}

export type BinaryResolution =
  | { ok: true; path: string; kind: 'exe' | 'cmd' | 'posix' }
  | { ok: false; reason: 'unknown_provider' | 'not_found' };

export interface ProviderRegistry {
  get(id: Provider): ProviderAdapter | undefined;
  list(): readonly ProviderAdapter[];
  categorize(id: Provider, toolName: string): ToolCategory;
  resolveBinary(id: Provider, lookup: BinaryLookup): BinaryResolution;
  normalize(id: Provider, raw: unknown, ctx: NormalizeContext): AgentEvent[];
}

export function createProviderRegistry(adapters: readonly ProviderAdapter[]): ProviderRegistry {
  const byId = new Map<Provider, ProviderAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) throw new Error(`Duplicate provider adapter: ${adapter.id}`);
    byId.set(adapter.id, adapter);
  }
  const listed = [...adapters];
  return {
    get: (id) => byId.get(id),
    list: () => listed,
    categorize: (id, toolName) => {
      const map = byId.get(id)?.toolCategories;
      // Own properties only: a tool named `constructor` or `__proto__` is just unmapped.
      return map !== undefined && Object.hasOwn(map, toolName)
        ? (map[toolName] ?? 'other')
        : 'other';
    },
    resolveBinary: (id, lookup) => {
      const adapter = byId.get(id);
      if (adapter === undefined) return { ok: false, reason: 'unknown_provider' };
      return resolveCommand(adapter.binary.command, lookup);
    },
    normalize: (id, raw, ctx) => {
      const adapter = byId.get(id);
      return adapter === undefined ? [] : safeNormalize(adapter, raw, ctx);
    },
  };
}

/** The Windows extensions a spawn can run, and how. Script hosts (`.js`, `.vbs`, `.ps1`) aren't. */
const WINDOWS_KINDS: Readonly<Record<string, 'exe' | 'cmd'>> = {
  '.com': 'exe',
  '.exe': 'exe',
  '.bat': 'cmd',
  '.cmd': 'cmd',
};

/** A Windows PATH entry as the shell reads it: surrounding spaces and double quotes removed. */
function windowsPathEntry(entry: string): string {
  const trimmed = entry.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

/**
 * Searches the absolute PATH directories in order, the way Windows and a POSIX shell do, but never
 * the current directory: a hostile repo's `claude.cmd` must not win. On Windows only PATHEXT
 * extensions a spawn can run are tried (the extensionless name isn't runnable there, and script
 * hosts are skipped).
 *
 * `kind: 'cmd'` (`.cmd`/`.bat`, such as npm's `claude.cmd` shim) only runs through cmd.exe, which
 * re-parses the command line, and a shim forwarding `%*` parses it again: argv quoting doesn't
 * protect an argument (a prompt holding `"` and `&` runs commands), escaping once still injects,
 * and escaping twice splits the argument and drops line breaks. Every argument is exposed, not
 * only the prompt: a `&` in the `--settings` path under the user's home splits it too. So the
 * spawn (task 2.6) runs the shim's real target (`node <cli.js>`, or a native `.exe`) instead, or
 * refuses to start and says why. It never passes arguments through cmd.exe.
 */
export function resolveCommand(command: string, lookup: BinaryLookup): BinaryResolution {
  if (!BARE_COMMAND.test(command)) return { ok: false, reason: 'not_found' };
  const windows = lookup.platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const dirs = lookup.path
    .split(windows ? ';' : ':')
    .map((dir) => (windows ? windowsPathEntry(dir) : dir))
    .filter((dir) => paths.isAbsolute(dir));
  const extensions = windows
    ? (lookup.pathExt ?? DEFAULT_PATHEXT)
        .split(';')
        .map((ext) => ext.toLowerCase())
        .filter((ext) => Object.hasOwn(WINDOWS_KINDS, ext))
    : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = paths.join(dir, `${command}${ext}`);
      if (!lookup.isFile(candidate)) continue;
      if (!windows) return { ok: true, path: candidate, kind: 'posix' };
      return { ok: true, path: candidate, kind: WINDOWS_KINDS[ext] ?? 'exe' };
    }
  }
  return { ok: false, reason: 'not_found' };
}

/**
 * The adapter's events, made safe: each is validated, must belong to this session and provider,
 * and has its text, summary and raw scrubbed (and raw capped). A throw, a non-array or an invalid
 * event becomes an `unknown` event for the root agent that keeps the scrubbed input.
 */
function safeNormalize(
  adapter: ProviderAdapter,
  raw: unknown,
  ctx: NormalizeContext,
): AgentEvent[] {
  // The scrubbed input, computed once however many fallbacks need it.
  let kept: { raw: unknown } | undefined;
  const fallback = (): AgentEvent => {
    kept ??= { raw: scrubRaw(raw, { maxLength: RAW_MAX_LENGTH }) };
    return fallbackEvent(adapter.id, kept.raw, ctx);
  };
  let items: unknown[];
  try {
    const output: unknown = adapter.normalize(raw, ctx);
    if (!Array.isArray(output)) return [fallback()];
    // One copy, so a hostile array (a Proxy, a throwing length) is only read here.
    items = Array.from(output as unknown[]);
  } catch {
    return [fallback()];
  }
  return items.map((item) => {
    try {
      return checkedEvent(item, adapter.id, ctx) ?? fallback();
    } catch {
      return fallback();
    }
  });
}

function checkedEvent(
  candidate: unknown,
  provider: Provider,
  ctx: NormalizeContext,
): AgentEvent | undefined {
  const parsed = parseAgentEvent(candidate);
  if (!parsed.ok) return undefined;
  const event = parsed.value;
  // An adapter speaks for its own session and provider only, and time comes from the server's
  // clock, never from a provider (D15).
  if (event.sessionId !== ctx.sessionId || event.provider !== provider) return undefined;
  if (event.kind === 'clock.tick') return undefined;
  return scrubEvent(event);
}

function scrubEvent(event: AgentEvent): AgentEvent | undefined {
  const scrubbed: AgentEvent = { ...event };
  if (event.text !== undefined) scrubbed.text = scrubText(event.text);
  if (event.tool?.summary !== undefined) {
    scrubbed.tool = { ...event.tool, summary: scrubText(event.tool.summary) };
  }
  if (event.raw !== undefined) scrubbed.raw = scrubRaw(event.raw, { maxLength: RAW_MAX_LENGTH });
  const reparsed = parseAgentEvent(scrubbed);
  return reparsed.ok ? reparsed.value : undefined;
}

/** An `unknown` event for the root agent, keeping the input already scrubbed and capped. */
function fallbackEvent(provider: Provider, kept: unknown, ctx: NormalizeContext): AgentEvent {
  const event: AgentEvent = {
    v: EVENT_SCHEMA_VERSION,
    id: ctx.newId(),
    ts: ctx.receivedAt,
    sessionId: ctx.sessionId,
    provider,
    agentId: ctx.sessionId,
    kind: 'unknown',
  };
  return kept === undefined ? event : { ...event, raw: kept };
}
