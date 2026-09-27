// Unit tests for the pure helpers behind integrity.test.ts.

import { describe, expect, it } from 'vitest';
import {
  collectHooks,
  deniedBySettings,
  type HookEntry,
  hardRuleIdNumbers,
  hardRuleNumbers,
  importsModule,
  matcherNames,
  matcherProblems,
  numberingProblems,
  parseFrontmatter,
  parsePermissionRules,
  pathPatternToRegExp,
  projectPaths,
  representativePath,
} from './integrity.ts';

function hook(overrides: Partial<HookEntry>): HookEntry {
  return {
    event: 'PreToolUse',
    matcher: undefined,
    type: 'command',
    command: 'node',
    args: [],
    timeout: 5,
    ...overrides,
  };
}

describe('collectHooks', () => {
  it('flattens events, groups and handlers and skips junk', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node', args: ['a.ts', 3], timeout: 10 }, 'junk'],
          },
          'junk',
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        Stop: 'not an array',
      },
    };
    expect(collectHooks(settings)).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        type: 'command',
        command: 'node',
        args: ['a.ts'],
        timeout: 10,
      },
      {
        event: 'SessionStart',
        matcher: undefined,
        type: 'command',
        command: 'echo hi',
        args: [],
        timeout: undefined,
      },
    ]);
    expect(collectHooks(null)).toEqual([]);
    expect(collectHooks({ hooks: [] })).toEqual([]);
    expect(collectHooks({ hooks: { X: [{ hooks: [{ command: 1 }] }] } })[0]).toMatchObject({
      type: undefined,
      command: undefined,
    });
  });
});

describe('projectPaths', () => {
  it('finds CLAUDE_PROJECT_DIR references in command and args', () => {
    expect(
      projectPaths(
        hook({
          command: `"\${CLAUDE_PROJECT_DIR}/bin/x.sh" --flag`,
          args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/a.ts`, 'plain'],
        }),
      ),
    ).toEqual(['bin/x.sh', '.claude/hooks/a.ts']);
    expect(projectPaths(hook({ command: undefined }))).toEqual([]);
  });
});

describe('matcherNames / matcherProblems', () => {
  it.each([
    [undefined, []],
    ['', []],
    ['*', []],
    ['Bash', ['Bash']],
    ['Edit|Write, Read', ['Edit', 'Write', 'Read']],
    ['mcp__.*', null],
    ['^Edit$', null],
  ] as const)('%j → %j', (matcher, expected) => {
    expect(matcherNames(matcher)).toEqual(expected);
  });

  it.each([
    [hook({ matcher: 'Bash|PowerShell|Edit' }), []],
    // MultiEdit was removed from Claude Code's tools reference by 2.1.283, so it counts as stale.
    [
      hook({ matcher: 'Bash|MultiEdit' }),
      ['PreToolUse matcher "Bash|MultiEdit": unknown "MultiEdit"'],
    ],
    [
      hook({ event: 'PostToolUse', matcher: 'Edit|Wrte' }),
      ['PostToolUse matcher "Edit|Wrte": unknown "Wrte"'],
    ],
    [
      hook({ matcher: 'Edit.*' }),
      ['PreToolUse matcher "Edit.*" is a regular expression; use exact names'],
    ],
    [hook({ event: 'SessionStart', matcher: 'startup|compact' }), []],
    [
      hook({ event: 'SessionStart', matcher: 'Bash' }),
      ['SessionStart matcher "Bash": unknown "Bash"'],
    ],
    [
      hook({ event: 'Notification', matcher: 'x' }),
      ['Notification has no verified matcher list here: add one to integrity.ts'],
    ],
  ] as const)('%j', (entry, expected) => {
    expect(matcherProblems(entry)).toEqual(expected);
  });
});

describe('permission rules', () => {
  const rules = parsePermissionRules([
    'Read(~/.claude)',
    'Read(~/.claude/**)',
    'Read(!~/.claude/plans/**)',
    'Read(!~/.claude/projects/*/memory/**)',
    'Edit(~/.claude/**)',
    'Bash',
    'Bash(git push *)',
  ]);

  it('parses tool, pattern and negation, skipping bare rules', () => {
    expect(rules).toHaveLength(6);
    expect(rules[2]).toEqual({ tool: 'Read', pattern: '~/.claude/plans/**', negated: true });
  });

  it.each([
    ['~/.claude/**', '~/.claude/a/b.json', true],
    ['~/.claude/**', '~/.claudex/a', false],
    ['~/.claude/projects/*/memory/**', '~/.claude/projects/slug/memory/M.md', true],
    ['~/.claude/projects/*/memory/**', '~/.claude/projects/a/b/memory/M.md', false],
    ['.env.?', '.env.x', true],
    ['.env', '.env', true],
    ['.env', 'xenv', false],
  ])('%s matches %s: %s', (pattern, filePath, expected) => {
    expect(pathPatternToRegExp(pattern).test(filePath)).toBe(expected);
  });

  it.each([
    ['Read', '~/.claude/settings.json', true],
    ['Read', '~/.claude/plans/sample/file.md', false],
    ['Read', '~/.claude/projects/s/memory/M.md', false],
    ['Edit', '~/.claude/plans/x.md', true],
    ['Write', '~/.claude/settings.json', false],
    ['Read', '/repo/.claude/settings.json', false],
  ])('%s %s denied: %s', (tool, filePath, expected) => {
    expect(deniedBySettings(tool, filePath, rules)).toBe(expected);
  });

  it('builds a representative path for a carve-out', () => {
    expect(representativePath('~/.claude/projects/*/memory/**')).toBe(
      '~/.claude/projects/C--Users-alice-repo/memory/sample/file.md',
    );
  });
});

describe('parseFrontmatter', () => {
  it('parses plain, quoted, folded and literal values and continuation lines', () => {
    const markdown = [
      '---',
      'name: reviewer',
      'description: "Quoted: with colon"',
      'folded: >',
      '  line one',
      '  line two',
      'literal: |-',
      '  a',
      '  b',
      'plain: first',
      '  continued',
      'empty:',
      'list: [a, b]',
      '---',
      '# Body',
      'name: not frontmatter',
    ].join('\r\n');
    expect(Object.fromEntries(parseFrontmatter(markdown) ?? [])).toEqual({
      name: 'reviewer',
      description: 'Quoted: with colon',
      folded: 'line one line two',
      literal: 'a\nb',
      plain: 'first continued',
      empty: '',
      list: '[a, b]',
    });
  });

  it.each([
    ['no frontmatter', '# Title\nname: x'],
    ['unterminated', '---\nname: x\n'],
  ])('returns null for %s', (_, markdown) => {
    expect(parseFrontmatter(markdown)).toBeNull();
  });

  it('ignores stray indented lines before the first key', () => {
    expect(Object.fromEntries(parseFrontmatter('---\n  stray\nname: a\n---') ?? [])).toEqual({
      name: 'a',
    });
  });
});

describe('hard rules', () => {
  const claudeMd = [
    '# X',
    '1. not a rule',
    '## Hard rules (security)',
    '',
    '1. **One**',
    '2. Two',
    '   3. nested text is not a rule',
    '3. Three',
    '## Working style',
    '4. not a rule',
  ].join('\n');

  it('reads only the Hard rules section', () => {
    expect(hardRuleNumbers(claudeMd)).toEqual([1, 2, 3]);
    expect(hardRuleNumbers('## Hard rules\n1. a\n2. b')).toEqual([1, 2]);
    expect(hardRuleNumbers('# nothing')).toEqual([]);
  });

  it.each([
    [[1, 2, 3], []],
    [[], ['no numbered hard rules found']],
    [[1, 3], ['hard rule at position 2 is numbered 3']],
    [[2], ['hard rule at position 1 is numbered 2']],
  ])('numberingProblems(%j)', (numbers, expected) => {
    expect(numberingProblems(numbers)).toEqual(expected);
  });

  it('collects HR numbers from rule ids', () => {
    expect([...hardRuleIdNumbers(['HR1-a', 'HR3-b', 'HR3-c', 'HR12-d', 'SEC-x', 'HRx-y'])]).toEqual(
      [1, 3, 12],
    );
  });
});

describe('importsModule', () => {
  it.each([
    ["import { a } from '../../../.claude/hooks/guard.ts';", true],
    ['import {\n  a,\n} from "../../.claude/hooks/guard.ts"', true],
    ["export { a } from '..\\\\.claude\\\\hooks\\\\guard.ts';", true],
    ["import { a } from '../../../.claude/hooks/xguard.ts';", false],
    ["const p = new URL('../../../.claude/hooks/guard.ts', import.meta.url);", false],
    ["import { a } from './guard.ts';", false],
  ])('%s → %s', (source, expected) => {
    expect(importsModule(source, '.claude/hooks/guard.ts')).toBe(expected);
  });
});
