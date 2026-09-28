// Task 2.1, clause 18: packages/shared has no I/O and no side effects in its source, and exports
// only through src/index.ts (packages/shared/CLAUDE.md). This scans source files, not tests.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = import.meta.dirname;
const PACKAGE_JSON = path.resolve(SRC, '..', 'package.json');

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !/\.test\.tsx?$/.test(file) && !/\.test-helpers\.tsx?$/.test(file))
    .map((file) => path.join(SRC, file));
}

/** Source without comments, so prose like "the process tree" doesn't count. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'a node: import', pattern: /from\s+['"]node:|import\(\s*['"]node:|require\(/ },
  { name: 'process', pattern: /\bprocess\s*\.|\bprocess\s*\[|globalThis\.process/ },
  { name: 'Date.now()', pattern: /\bDate\s*\.\s*now\b/ },
  { name: 'new Date()', pattern: /\bnew\s+Date\s*\(/ },
  { name: 'Math.random()', pattern: /\bMath\s*\.\s*random\b/ },
  { name: 'crypto randomness', pattern: /\bcrypto\s*\.|\brandomUUID\b|\bgetRandomValues\b/ },
  { name: 'performance.now()', pattern: /\bperformance\s*\./ },
  { name: 'a timer', pattern: /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/ },
  { name: 'logging', pattern: /\bconsole\s*\./ },
  { name: 'network I/O', pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/ },
];

describe('packages/shared source has no I/O and no side effects', () => {
  it('has source files to check', () => {
    const names = sourceFiles().map((file) => path.basename(file));
    expect(names).toContain('index.ts');
    expect(names.length).toBeGreaterThan(2);
  });

  it.each(FORBIDDEN)('no source file uses $name', ({ pattern }) => {
    const offenders = sourceFiles()
      .filter((file) => pattern.test(code(file)))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('imports only relative modules and zod', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const specifiers = [...code(file).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const specifier of specifiers) {
        if (specifier === undefined) continue;
        const allowed =
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          specifier === 'zod' ||
          specifier.startsWith('zod/');
        if (!allowed) offenders.push(`${path.relative(SRC, file)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('packages/shared public surface', () => {
  it('package.json exports only src/index.ts', () => {
    const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    expect(pkg).toMatchObject({ exports: { '.': './src/index.ts' } });
    const exportsField =
      typeof pkg === 'object' && pkg !== null && 'exports' in pkg ? pkg.exports : undefined;
    expect(Object.keys(exportsField ?? {})).toEqual(['.']);
  });

  it('index.ts exports the 2.1 surface', async () => {
    const surface = await import('./index.ts');
    for (const name of [
      'TOOL_CATEGORIES',
      'EVENT_KINDS',
      'EVENT_SCHEMA_VERSION',
      'PROTOCOL_VERSION',
      'DEFAULT_THRESHOLDS',
      'parseAgentEvent',
      'parseServerFrame',
      'parseClientFrame',
      'createWorld',
      'reduce',
    ]) {
      expect(surface, name).toHaveProperty(name);
    }
  });
});
