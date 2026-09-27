import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  brokenLinks,
  CONTEXT_BUDGET_BYTES,
  findMarkdownFiles,
  relativeLinkTargets,
  stripCode,
} from './links.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');

describe('relativeLinkTargets', () => {
  it.each([
    ['[a](docs/PLAN.md)', ['docs/PLAN.md']],
    ['[a](../x.md#section)', ['../x.md']],
    ['[a](<path with spaces.md>)', ['path with spaces.md']],
    ['[a](y.md "title")', ['y.md']],
    ['![img](assets/a.png)', ['assets/a.png']],
    ['[a](https://example.com) [b](mailto:x@y.z) [c](#anchor)', []],
    ['[a](dir%20name/file.md)', ['dir name/file.md']],
    ['see `[not](a-link.md)` inline', []],
    ['```md\n[not](a-link.md)\n```\n[yes](b.md)', ['b.md']],
  ])('%j → %j', (markdown, expected) => {
    expect(relativeLinkTargets(markdown)).toEqual(expected);
  });

  it('keeps text between two separate code fences', () => {
    expect(stripCode('```\nx\n```\nkeep\n```\ny\n```')).toBe('\nkeep\n');
  });
});

describe('repository Markdown', () => {
  const files = findMarkdownFiles(REPO_ROOT);

  it('finds the docs it is supposed to check', () => {
    const relative = files.map((file) => path.relative(REPO_ROOT, file).replaceAll('\\', '/'));
    expect(relative).toEqual(expect.arrayContaining(['CLAUDE.md', 'docs/PLAN.md', 'README.md']));
    expect(relative.some((file) => file.startsWith('node_modules/'))).toBe(false);
  });

  it('has no broken relative links', () => {
    const broken = files.flatMap((file) =>
      brokenLinks(file, readFileSync(file, 'utf8'), REPO_ROOT),
    );
    expect(broken).toEqual([]);
  });
});

describe('always-loaded context budget', () => {
  it('keeps the root CLAUDE.md within budget', () => {
    expect(statSync(path.join(REPO_ROOT, 'CLAUDE.md')).size).toBeLessThanOrEqual(
      CONTEXT_BUDGET_BYTES.root,
    );
  });

  it.each(['packages/shared', 'packages/hook-relay', 'apps/server', 'apps/web'])(
    'keeps %s/CLAUDE.md within budget',
    (dir) => {
      expect(statSync(path.join(REPO_ROOT, dir, 'CLAUDE.md')).size).toBeLessThanOrEqual(
        CONTEXT_BUDGET_BYTES.package,
      );
    },
  );
});
