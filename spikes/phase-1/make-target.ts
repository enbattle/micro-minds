// Creates the scratch repository Phase 1 records in (PLAN §10, "Record in a scratch repo, never in
// micro-minds"): a few source files and a script that fails, for scenario (c). Refuses to touch
// an existing non-empty directory.
//
//   npm run spike:target

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const TARGET = path.join(homedir(), 'micro-minds-spike-target');

const FILES: Record<string, string> = {
  'README.md': '# spike target\n\nA scratch repository for recording Claude Code hook payloads.\n',
  'package.json': `${JSON.stringify(
    {
      name: 'spike-target',
      private: true,
      type: 'module',
      scripts: { test: 'node scripts/fail.js' },
    },
    null,
    2,
  )}\n`,
  'src/math.js': [
    '// Small pure functions to read and edit in the recorded scenarios.',
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export function multiply(a, b) {',
    '  return a * b;',
    '}',
    '',
  ].join('\n'),
  'src/greet.js': [
    "import { add } from './math.js';",
    '',
    'export function greet(name) {',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: file content, not a template.
    '  return `Hello, ${name}! 2 + 2 = ${add(2, 2)}`;',
    '}',
    '',
  ].join('\n'),
  'scripts/fail.js': [
    '// Always fails, for scenario (c): a shell command that exits non-zero.',
    "console.error('fail.js: simulated failure (expected)');",
    'process.exit(3);',
    '',
  ].join('\n'),
};

/**
 * Writes the scratch files into `dir` (new or empty) and commits them. Git runs only here, on a
 * directory nothing else has written to yet, so no hook or filter a recorded agent planted can run.
 */
export function createTarget(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} already exists and isn't empty; leaving it alone.`);
  }
  for (const [rel, text] of Object.entries(FILES)) {
    const file = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git(
    '-c',
    'user.name=spike',
    '-c',
    'user.email=spike@example.invalid',
    'commit',
    '-q',
    '-m',
    'Scratch target for Phase 1 recordings',
  );
}

function main(): number {
  try {
    createTarget(TARGET);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(`Created ${TARGET}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
