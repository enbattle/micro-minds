// Doc freshness checks (docs/dev-harness.md, principles 1 and 5). Stale docs mislead agents more
// than missing ones, so every relative Markdown link must resolve, and the always-loaded
// CLAUDE.md files stay within a size budget.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Directories never scanned for Markdown. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'results',
  'playwright-report',
  'test-results',
]);

/** Every `.md` file under `root`, skipping build output, dependencies and eval results. */
export function findMarkdownFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.md')) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** Removes fenced code blocks and inline code spans, where link syntax is only an example. */
export function stripCode(markdown: string): string {
  return markdown
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

// `[text](target)`, `[text](<target with spaces>)` and `[text](target "title")`.
const LINK = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

/** Relative link targets in a Markdown document, without `#anchors` or `?queries`. */
export function relativeLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of stripCode(markdown).matchAll(LINK)) {
    const raw = match[1] ?? match[2];
    if (raw === undefined || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
    const target = raw.split(/[#?]/)[0];
    if (target !== undefined && target.length > 0) targets.push(decodeURI(target));
  }
  return targets;
}

/** Broken relative links in one file, as `file: target` strings relative to `root`. */
export function brokenLinks(file: string, markdown: string, root: string): string[] {
  return relativeLinkTargets(markdown)
    .filter((target) => !existsSync(path.resolve(path.dirname(file), target)))
    .map((target) => `${path.relative(root, file).replaceAll('\\', '/')}: ${target}`);
}

/**
 * Byte budgets for always-loaded context. Root CLAUDE.md holds rules and pointers; package files
 * hold only what's specific to that package. Move detail into linked docs rather than raising
 * these.
 */
export const CONTEXT_BUDGET_BYTES = {
  root: 7_000,
  package: 2_000,
} as const;
