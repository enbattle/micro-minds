// PostToolUse formatter (PLAN task 0.5): runs Biome on a file right after Claude edits it.
//
// Contract: always exit 0 and never write to stdout, so a formatting problem can never block or
// alter the session. Failures are one line on stderr (Claude Code writes it to the debug log).
// The platform Biome binary is spawned directly (no npx, no shell) to keep each edit fast.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Extensions Biome formats in this repo (see biome.json).
export const FORMATTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.css',
]);

const BIOME_TIMEOUT_MS = 15_000;

export type Invocation = { readonly command: string; readonly args: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** The edited file from a PostToolUse payload for Edit, Write or MultiEdit, or null. */
export function extractFilePath(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of ['tool_input', 'tool_response'] as const) {
    const section = input[key];
    if (!isRecord(section)) continue;
    for (const field of ['file_path', 'filePath'] as const) {
      const value = section[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return null;
}

/** True when the file has a Biome-formatted extension and lives inside the project (not in node_modules). */
export function shouldFormat(
  filePath: string,
  projectDir: string,
  platform: NodeJS.Platform,
): boolean {
  const api = pathApi(platform);
  if (!FORMATTABLE_EXTENSIONS.has(api.extname(filePath).toLowerCase())) return false;

  const relative = api.relative(api.resolve(projectDir), api.resolve(projectDir, filePath));
  if (relative.length === 0 || relative.startsWith('..') || api.isAbsolute(relative)) return false;
  return !relative.split(/[\\/]/).includes('node_modules');
}

/**
 * Candidate ways to run the project's own Biome, fastest first: the platform binary that
 * @biomejs/biome installs as an optional dependency, then its Node launcher script.
 */
export function biomeCandidates(
  projectDir: string,
  platform: NodeJS.Platform,
  arch: string,
  nodePath: string,
): Invocation[] {
  const api = pathApi(platform);
  const scope = api.join(projectDir, 'node_modules', '@biomejs');
  const exe = platform === 'win32' ? 'biome.exe' : 'biome';
  const packages = [`cli-${platform}-${arch}`];
  if (platform === 'linux') packages.push(`cli-${platform}-${arch}-musl`);
  return [
    ...packages.map((name) => ({ command: api.join(scope, name, exe), args: [] })),
    { command: nodePath, args: [api.join(scope, 'biome', 'bin', 'biome')] },
  ];
}

/** The full Biome invocation for one file. */
export function formatInvocation(biome: Invocation, filePath: string): Invocation {
  return {
    command: biome.command,
    args: [...biome.args, 'format', '--write', '--no-errors-on-unmatched', filePath],
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<unknown>) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function fail(message: string): void {
  process.stderr.write(`micro-minds format: ${message}\n`);
}

async function main(): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    fail('stdin is not valid JSON');
    return;
  }

  const filePath = extractFilePath(input);
  if (filePath === null) return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  if (!shouldFormat(filePath, projectDir, process.platform)) return;

  const biome = biomeCandidates(projectDir, process.platform, process.arch, process.execPath).find(
    // The Node launcher candidate is usable when its script exists; binaries when they exist.
    (candidate) => existsSync(candidate.args[0] ?? candidate.command),
  );
  if (biome === undefined) {
    fail('Biome is not installed in node_modules (run npm install)');
    return;
  }

  const { command, args } = formatInvocation(biome, path.resolve(projectDir, filePath));
  const result = spawnSync(command, args, {
    cwd: projectDir,
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: BIOME_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    fail(`could not run Biome (${result.error.message})`);
  } else if (result.status !== 0) {
    const firstLine = result.stderr.split(/\r?\n/).find((line) => line.trim().length > 0);
    fail(`Biome exited with ${result.status ?? result.signal}: ${firstLine ?? 'no details'}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    fail(`internal error (${error instanceof Error ? error.message : String(error)})`);
  }
  process.exitCode = 0;
}
