// Preflight (PLAN §5.6 startup step 5): which provider CLIs are installed. A PATH lookup through
// the registry, then the adapter's version command with a timeout. Login state is never checked,
// and no credential file is read (hard rule 1). Never throws.
import { execFile } from 'node:child_process';
import type { Provider } from '@micro-minds/shared';
import type { BinaryLookup, ProviderRegistry } from '../providers/registry.ts';
import { launchTarget } from './binary.ts';

export interface PreflightResult {
  provider: Provider;
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface PreflightOptions {
  registry: ProviderRegistry;
  lookup: BinaryLookup;
  timeoutMs: number;
}

export function runPreflight(options: PreflightOptions): Promise<PreflightResult[]> {
  return Promise.all(options.registry.list().map((adapter) => check(adapter.id, options)));
}

async function check(provider: Provider, options: PreflightOptions): Promise<PreflightResult> {
  const adapter = options.registry.get(provider);
  if (adapter === undefined) return { provider, found: false, error: 'unknown provider' };
  try {
    const resolved = options.registry.resolveBinary(provider, options.lookup);
    if (!resolved.ok) {
      return { provider, found: false, error: `${adapter.binary.command} not found on PATH` };
    }
    const target = launchTarget(resolved, options.lookup);
    if (!target.ok) return { provider, found: true, path: resolved.path, error: target.reason };
    const outcome = await run(
      target.file,
      [...target.prefixArgs, ...adapter.binary.versionArgs],
      options.timeoutMs,
    );
    if (!outcome.ok) return { provider, found: true, path: resolved.path, error: outcome.error };
    const version = outcome.stdout.trim();
    return version === ''
      ? { provider, found: true, path: resolved.path, error: 'the version command printed nothing' }
      : { provider, found: true, path: resolved.path, version };
  } catch (error: unknown) {
    return {
      provider,
      found: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error === null) resolve({ ok: true, stdout });
          else if (error.killed) resolve({ ok: false, error: `timed out after ${timeoutMs} ms` });
          else resolve({ ok: false, error: error.message });
        },
      );
    } catch (error: unknown) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
