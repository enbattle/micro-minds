// Harness integrity: the pieces of the dev harness (settings, hooks, guard, agents, skills,
// CLAUDE.md, the reviewer catalog, harness tests) agree with each other. Deterministic; runs in
// CI through the `harness` Vitest project.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, type GuardContext } from '../../../.claude/hooks/guard.ts';
import { extractRuleCatalog } from '../reviewer/score.ts';
import {
  collectHooks,
  deniedBySettings,
  hardRuleIdNumbers,
  hardRuleNumbers,
  importsModule,
  matcherProblems,
  numberingProblems,
  parseFrontmatter,
  parsePermissionRules,
  projectPaths,
  representativePath,
} from './integrity.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const read = (relative: string): string => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const settings: unknown = JSON.parse(read('.claude/settings.json'));
const hooks = collectHooks(settings);

function permissionList(kind: 'allow' | 'deny'): string[] {
  const permissions =
    typeof settings === 'object' && settings !== null && 'permissions' in settings
      ? settings.permissions
      : undefined;
  const list =
    typeof permissions === 'object' && permissions !== null && kind in permissions
      ? (permissions as Record<string, unknown>)[kind]
      : undefined;
  return Array.isArray(list) ? list.filter((rule): rule is string => typeof rule === 'string') : [];
}

describe('settings.json hooks', () => {
  it('has hooks to check', () => {
    expect(hooks.length).toBeGreaterThan(0);
  });

  it.each(hooks.map((hook) => [`${hook.event} ${hook.args.join(' ')}`, hook] as const))(
    '%s: referenced project files exist',
    (_, hook) => {
      for (const relative of projectPaths(hook)) {
        expect(existsSync(path.join(REPO_ROOT, relative)), relative).toBe(true);
      }
    },
  );

  it.each(hooks.map((hook) => [`${hook.event} ${hook.args.join(' ')}`, hook] as const))(
    '%s: matcher uses verified names and a timeout is set',
    (_, hook) => {
      expect(matcherProblems(hook)).toEqual([]);
      expect(hook.timeout, 'every hook needs a timeout (seconds)').toBeGreaterThan(0);
    },
  );
});

describe('hook files', () => {
  const hookFiles = readdirSync(path.join(REPO_ROOT, '.claude', 'hooks')).filter((file) =>
    file.endsWith('.ts'),
  );
  const referenced = new Set(hooks.flatMap(projectPaths));
  const harnessTests = readdirSync(path.join(REPO_ROOT, 'evals', 'harness'), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.test.ts') && !file.includes('node_modules'))
    .map((file) => readFileSync(path.join(REPO_ROOT, 'evals', 'harness', file), 'utf8'));

  it('finds hook files', () => {
    expect(hookFiles.length).toBeGreaterThan(0);
  });

  it.each(hookFiles)('%s is registered in settings.json (no orphan hooks)', (file) => {
    expect(referenced.has(`.claude/hooks/${file}`)).toBe(true);
  });

  it.each(hookFiles)('%s is imported by a test under evals/harness', (file) => {
    expect(harnessTests.some((source) => importsModule(source, `.claude/hooks/${file}`))).toBe(
      true,
    );
  });
});

describe('guard ↔ settings: the ~/.claude exemption agrees', () => {
  const rules = parsePermissionRules(permissionList('deny'));
  const carveOuts = rules.filter((rule) => rule.negated && rule.pattern.startsWith('~/.claude/'));
  const contexts: readonly GuardContext[] = [
    { homeDir: '/home/alice', cwd: '/home/alice/repo', platform: 'linux' },
    { homeDir: 'C:\\Users\\alice', cwd: 'C:\\Users\\alice\\repo', platform: 'win32' },
  ];
  const guardDecision = (tool: string, filePath: string, ctx: GuardContext): string =>
    decide({ tool_name: tool, tool_input: { file_path: filePath } }, ctx).decision;

  it('has ~/.claude carve-outs for Read and Edit', () => {
    expect(new Set(carveOuts.map((rule) => rule.tool))).toEqual(new Set(['Read', 'Edit']));
  });

  it.each(carveOuts.map((rule) => [`${rule.tool}(!${rule.pattern})`, rule] as const))(
    '%s: settings and guard both allow a representative path',
    (_, rule) => {
      const filePath = representativePath(rule.pattern);
      expect(deniedBySettings(rule.tool, filePath, rules)).toBe(false);
      for (const ctx of contexts) {
        expect(guardDecision(rule.tool, filePath, ctx), `${ctx.platform}: ${filePath}`).toBe(
          'allow',
        );
      }
    },
  );

  it.each([
    ['Read', '~/.claude/.credentials.json'],
    ['Read', '~/.claude/settings.json'],
    ['Read', '~/.claude/projects/C--Users-alice-repo/session.jsonl'],
    ['Read', '~/.claude/plans-evil/x.md'],
    ['Edit', '~/.claude/settings.json'],
    ['Edit', '~/.claude/projects/C--Users-alice-repo/tool-results/x.txt'],
  ])('%s %s: denied by settings and by the guard', (tool, filePath) => {
    expect(deniedBySettings(tool, filePath, rules)).toBe(true);
    for (const ctx of contexts) expect(guardDecision(tool, filePath, ctx)).toBe('deny');
  });
});

describe('agents and skills frontmatter', () => {
  const agentFiles = readdirSync(path.join(REPO_ROOT, '.claude', 'agents')).filter((file) =>
    file.endsWith('.md'),
  );
  const skillDirs = readdirSync(path.join(REPO_ROOT, '.claude', 'skills'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it('discovers agents and skills', () => {
    expect(agentFiles.length).toBeGreaterThan(0);
    expect(skillDirs.length).toBeGreaterThan(0);
  });

  it.each(agentFiles)('agent %s: name equals the file stem, description is set', (file) => {
    const fields = parseFrontmatter(read(`.claude/agents/${file}`));
    expect(fields).not.toBeNull();
    expect(fields?.get('name')).toBe(path.basename(file, '.md'));
    expect(fields?.get('description')?.trim()).toBeTruthy();
  });

  // `name` is optional for skills (it defaults to the directory name, per
  // https://code.claude.com/docs/en/skills), so it's only checked when present.
  it.each(skillDirs)('skill %s: SKILL.md frontmatter, matching name, description', (dir) => {
    const file = `.claude/skills/${dir}/SKILL.md`;
    expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
    const fields = parseFrontmatter(read(file));
    expect(fields).not.toBeNull();
    expect(fields?.get('name') ?? dir).toBe(dir);
    expect(fields?.get('description')?.trim()).toBeTruthy();
  });
});

describe('hard-rule numbering', () => {
  const numbers = hardRuleNumbers(read('CLAUDE.md'));
  const catalogNumbers = hardRuleIdNumbers(extractRuleCatalog(read('.claude/agents/reviewer.md')));

  it("CLAUDE.md's hard rules are numbered 1..N", () => {
    expect(numberingProblems(numbers)).toEqual([]);
  });

  it('the reviewer catalog has an HR<k>- rule for every hard rule and none beyond N', () => {
    const n = numbers.length;
    const missing = Array.from({ length: n }, (_, i) => i + 1).filter(
      (k) => !catalogNumbers.has(k),
    );
    const extra = [...catalogNumbers].filter((k) => k < 1 || k > n);
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });
});
