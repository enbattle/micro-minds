// Task 2.6, clause C12: preflight (PLAN §5.6 startup step 5). For each registered provider: a PATH
// lookup through the registry, then its version command with a timeout. Every registry here is
// built from test adapters whose binary is `node` (or missing), so no real provider CLI runs
// (C14). Preflight never throws.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fakeAdapter } from '../providers/fake/adapter.ts';
import { createProviderRegistry } from '../providers/registry.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import { testLookup } from './lookup.test-helpers.ts';
import { runPreflight } from './preflight.ts';

function adapter(
  id: ProviderAdapter['id'],
  command: string,
  versionArgs: readonly string[],
): ProviderAdapter {
  return { ...fakeAdapter, id, binary: { command, versionArgs } };
}

const TIMEOUT_MS = 1_000;

describe('runPreflight (C12)', { timeout: 30_000 }, () => {
  it('reports every registered provider, in order: found with path and version, or not found', async () => {
    const lookup = testLookup();
    const registry = createProviderRegistry([
      adapter('fake', 'node', ['--version']),
      adapter('gemini', 'mm-no-such-binary-26', ['--version']),
    ]);
    const resolved = registry.resolveBinary('fake', lookup);
    if (!resolved.ok) throw new Error('node must be on the test PATH');
    const expectedVersion = execFileSync(resolved.path, ['--version'], { encoding: 'utf8' }).trim();

    const results = await runPreflight({ registry, lookup, timeoutMs: 10_000 });

    expect(results.map((r) => r.provider)).toEqual(['fake', 'gemini']);
    expect(results[0]).toMatchObject({ provider: 'fake', found: true, path: resolved.path });
    expect(results[0]?.version).toBe(expectedVersion);
    expect(results[1]).toMatchObject({ provider: 'gemini', found: false });
    expect(results[1]?.version).toBeUndefined();
  });

  it.each([
    {
      name: 'the version command fails',
      versionArgs: ['-e', 'process.exit(2)'],
    },
    {
      name: 'the version command hangs past the timeout',
      versionArgs: ['-e', 'setInterval(() => {}, 1000)'],
    },
  ])('reports the error, with the path, when $name', async ({ versionArgs }) => {
    const lookup = testLookup();
    const registry = createProviderRegistry([adapter('fake', 'node', versionArgs)]);
    const resolved = registry.resolveBinary('fake', lookup);
    const startedAt = Date.now();

    const [result] = await runPreflight({ registry, lookup, timeoutMs: TIMEOUT_MS });

    expect(Date.now() - startedAt).toBeLessThan(TIMEOUT_MS + 10_000);
    expect(result).toMatchObject({ provider: 'fake', found: true });
    expect(resolved.ok && result?.path === resolved.path).toBe(true);
    expect(result?.version).toBeUndefined();
    expect(typeof result?.error).toBe('string');
    expect(result?.error).not.toBe('');
  });

  it('never throws, even when the PATH lookup itself fails', async () => {
    const lookup = {
      ...testLookup(),
      isFile: (): boolean => {
        throw new Error('lookup failed on purpose');
      },
    };
    const registry = createProviderRegistry([adapter('fake', 'node', ['--version'])]);

    const results = await runPreflight({ registry, lookup, timeoutMs: TIMEOUT_MS });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provider: 'fake', found: false });
    expect(typeof results[0]?.error).toBe('string');
  });
});
