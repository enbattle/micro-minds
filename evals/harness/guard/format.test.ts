// Tests for the PostToolUse Biome formatter hook (.claude/hooks/format.ts).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  biomeCandidates,
  extractFilePath,
  formatInvocation,
  shouldFormat,
} from '../../../.claude/hooks/format.ts';

describe('shouldFormat', () => {
  it.each([
    ['C:\\repo\\src\\a.ts', 'C:\\repo', 'win32', true],
    ['c:/REPO/src/a.TSX', 'C:\\repo', 'win32', true],
    ['src\\b.json', 'C:\\repo', 'win32', true],
    ['C:\\repo\\styles\\x.css', 'C:\\repo', 'win32', true],
    ['C:\\repo\\README.md', 'C:\\repo', 'win32', false],
    ['C:\\other\\a.ts', 'C:\\repo', 'win32', false],
    ['D:\\repo\\a.ts', 'C:\\repo', 'win32', false],
    ['C:\\repo\\node_modules\\x\\a.js', 'C:\\repo', 'win32', false],
    ['/repo/a.mjs', '/repo', 'linux', true],
    ['/repo/a.cjs', '/repo', 'linux', true],
    ['/repo/tsconfig.jsonc', '/repo', 'linux', true],
    ['/repo/../outside.ts', '/repo', 'linux', false],
    ['/repo-other/a.ts', '/repo', 'linux', false],
    ['/repo/fixtures/a.jsonl', '/repo', 'linux', false],
    ['/repo/Makefile', '/repo', 'darwin', false],
    ['/repo', '/repo', 'linux', false],
  ] as const)('%s in %s (%s) -> %s', (file, project, platform, expected) => {
    expect(shouldFormat(file, project, platform)).toBe(expected);
  });
});

describe('extractFilePath', () => {
  it.each([
    [{ tool_input: { file_path: '/r/a.ts' } }, '/r/a.ts'],
    [{ tool_input: {}, tool_response: { filePath: '/r/b.ts' } }, '/r/b.ts'],
    [{ tool_input: { file_path: '' } }, null],
    [{ tool_input: { file_path: 7 } }, null],
    [{ tool_input: 'x' }, null],
    [null, null],
    ['str', null],
  ] as const)('%j -> %s', (input, expected) => {
    expect(extractFilePath(input)).toBe(expected);
  });
});

describe('biomeCandidates', () => {
  it('prefers the platform binary on Windows, then the Node launcher', () => {
    expect(biomeCandidates('C:\\repo', 'win32', 'x64', 'C:\\node.exe')).toEqual([
      { command: 'C:\\repo\\node_modules\\@biomejs\\cli-win32-x64\\biome.exe', args: [] },
      { command: 'C:\\node.exe', args: ['C:\\repo\\node_modules\\@biomejs\\biome\\bin\\biome'] },
    ]);
  });

  it('also tries the musl build on Linux', () => {
    expect(biomeCandidates('/repo', 'linux', 'arm64', '/node').map((c) => c.command)).toEqual([
      '/repo/node_modules/@biomejs/cli-linux-arm64/biome',
      '/repo/node_modules/@biomejs/cli-linux-arm64-musl/biome',
      '/node',
    ]);
  });

  it('builds a write invocation that tolerates ignored files', () => {
    expect(formatInvocation({ command: '/node', args: ['/b'] }, '/repo/a.ts')).toEqual({
      command: '/node',
      args: ['/b', 'format', '--write', '--no-errors-on-unmatched', '/repo/a.ts'],
    });
  });
});

describe('format.ts as a process', () => {
  const entry = fileURLToPath(new URL('../../../.claude/hooks/format.ts', import.meta.url));
  const projectDir = fileURLToPath(new URL('../../../', import.meta.url));
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  const run = (stdin: string) =>
    spawnSync(process.execPath, [entry], {
      input: stdin,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });

  it('exits 0 silently on malformed stdin, with one line on stderr', () => {
    const result = run('not json');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('micro-minds format: stdin is not valid JSON\n');
  });

  it('ignores files outside the project', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mm-format-'));
    const file = path.join(tempDir, 'a.ts');
    writeFileSync(file, 'const  x=1\n');
    const result = run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readFileSync(file, 'utf8')).toBe('const  x=1\n');
  });

  it('formats a file inside the project with the local Biome', () => {
    tempDir = mkdtempSync(path.join(projectDir, 'evals', 'harness', 'guard', '.tmp-format-'));
    const file = path.join(tempDir, 'a.ts');
    writeFileSync(file, 'const  x={a:1}\n');
    const result = run(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(readFileSync(file, 'utf8')).toBe('const x = { a: 1 };\n');
  });
});
