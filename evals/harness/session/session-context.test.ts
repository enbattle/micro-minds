// Tests for the SessionStart context hook (.claude/hooks/session-context.ts).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContext,
  type ContextInput,
  type ContextIo,
  comparePhases,
  currentPhase,
  formatOutput,
  gatherInput,
  MAX_LINE_LENGTH,
  MAX_LINES,
  MAX_TITLE_LENGTH,
  nextTask,
  PLAN_PATH,
  parseTaskTitles,
  phaseOf,
  truncate,
  UNCOVERED_PATH,
} from '../../../.claude/hooks/session-context.ts';
import { parsePlanTasks, type UncoveredSchedule } from '../reviewer/coverage.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'session-context.ts');

function tasks(entries: readonly (readonly [string, boolean])[]): ReadonlyMap<string, boolean> {
  return new Map(entries);
}

function schedule(entries: Record<string, string>): UncoveredSchedule {
  return new Map(Object.entries(entries).map(([rule, due]) => [rule, { due, why: 'test' }]));
}

function input(overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    branch: 'feat/x',
    dirtyCount: 0,
    tasks: tasks([
      ['0.1', true],
      ['1.1', false],
    ]),
    titles: new Map([['1.1', 'Capture sink.']]),
    schedule: schedule({}),
    ...overrides,
  };
}

describe('phase helpers', () => {
  it.each([
    ['0.1', '0'],
    ['2.14', '2'],
    ['4a.7', '4a'],
  ])('phaseOf(%s) = %s', (id, phase) => {
    expect(phaseOf(id)).toBe(phase);
  });

  it('orders phases numerically, then by suffix', () => {
    expect(['4a', '10', '4', '0', '4b', '2'].sort(comparePhases)).toEqual([
      '0',
      '2',
      '4',
      '4a',
      '4b',
      '10',
    ]);
    expect(comparePhases('3', '3')).toBe(0);
  });

  it.each([
    ['all done', [['0.1', true]], null, null],
    [
      'first unticked in document order',
      [
        ['0.1', true],
        ['1.2', false],
        ['1.1', false],
      ],
      '1.2',
      '1',
    ],
    [
      '2.10 after 2.9 in the document',
      [
        ['2.9', true],
        ['2.10', false],
      ],
      '2.10',
      '2',
    ],
    [
      '4a after 3',
      [
        ['3.12', true],
        ['4a.1', false],
        ['4a.2', false],
      ],
      '4a.1',
      '4a',
    ],
    [
      // Next task always comes from the current phase, so the two lines never disagree.
      'earliest phase wins even when listed later',
      [
        ['4a.1', false],
        ['3.1', false],
      ],
      '3.1',
      '3',
    ],
    [
      '4 before 4a',
      [
        ['4a.1', false],
        ['4.1', false],
      ],
      '4.1',
      '4',
    ],
  ] as const)('%s', (_, entries, next, phase) => {
    const map = tasks(entries);
    expect(nextTask(map)).toBe(next);
    expect(currentPhase(map)).toBe(phase);
  });

  it('truncates with an ellipsis only when needed', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('exactly10!', 10)).toBe('exactly10!');
    expect(truncate('abcde fghij', 7)).toBe('abcde…');
  });
});

describe('parseTaskTitles', () => {
  it('maps ids to the text after the id, ignoring other lines', () => {
    const plan = [
      '## Phase 1',
      '- [x] 0.1 Scaffold the repo.  ',
      '- [ ] 4a.7 A "demo" mode.',
      '- not a task',
      '  - [ ] 9.9 indented, ignored',
    ].join('\n');
    expect([...parseTaskTitles(plan)]).toEqual([
      ['0.1', 'Scaffold the repo.'],
      ['4a.7', 'A "demo" mode.'],
    ]);
  });
});

describe('buildContext', () => {
  it('shows branch, phase progress, next task, rules and workflow', () => {
    const text = buildContext(
      input({
        tasks: tasks([
          ['1.1', true],
          ['1.2', false],
          ['1.3', false],
        ]),
        titles: new Map([['1.2', 'Record scenarios.']]),
        schedule: schedule({ 'B-rule': '1.2', 'A-rule': '1.2', 'C-rule': '2.1' }),
        dirtyCount: 3,
      }),
    );
    expect(text).toContain('Branch: feat/x (3 uncommitted files)');
    expect(text).toContain('Current phase: 1 (1 of 3 tasks ticked)');
    expect(text).toContain('Next task: 1.2 Record scenarios.');
    expect(text).toMatch(/Reviewer rules due with 1\.2 .*: A-rule, B-rule$/m);
    expect(text).not.toContain('C-rule');
    expect(text).toContain('`/start-task 1.2`');
    expect(text).toContain('`/finish-task`');
    expect(text).toContain('`/run-phase 1`');
    expect(text).not.toContain('WARNING');
  });

  it('says none when no rules are due', () => {
    expect(buildContext(input())).toContain('Reviewer rules due with 1.1: none');
  });

  it('says unknown when the schedule is unreadable', () => {
    expect(buildContext(input({ schedule: null }))).toContain(
      `Reviewer rules due with 1.1: unknown (${UNCOVERED_PATH} unreadable)`,
    );
  });

  it('picks 4a tasks once phases 0-3 are done', () => {
    const text = buildContext(
      input({
        tasks: tasks([
          ['3.12', true],
          ['4a.1', true],
          ['4a.2', false],
        ]),
        titles: new Map(),
      }),
    );
    expect(text).toContain('Current phase: 4a (1 of 2 tasks ticked)');
    expect(text).toContain('`/run-phase 4a`');
    expect(text).toMatch(/^Next task: 4a\.2$/m);
  });

  it('handles an all-done PLAN', () => {
    const text = buildContext(input({ tasks: tasks([['0.1', true]]) }));
    expect(text).toContain(`All 1 task in ${PLAN_PATH} are ticked.`);
    expect(text).not.toContain('Next task');
    expect(text).not.toContain('/start-task');
    expect(text).not.toContain('/run-phase');
  });

  it.each([
    ['main', 2, true],
    ['main', 1, true],
    ['main', 0, false],
    ['main', null, false],
    ['feat/x', 5, false],
  ] as const)('branch %s with %s dirty files: warning %s', (branch, dirty, warns) => {
    const text = buildContext(input({ branch, dirtyCount: dirty }));
    expect(text.includes('Create a branch before changing files')).toBe(warns);
  });

  it.each([
    [{ branch: null, dirtyCount: null }, 'Branch: unknown (git failed)'],
    [{ branch: 'main', dirtyCount: 0 }, 'Branch: main (clean tree)'],
    [{ branch: 'HEAD', dirtyCount: 1 }, 'Branch: HEAD (1 uncommitted file)'],
  ] as const)('branch line for %j', (overrides, expected) => {
    expect(buildContext(input(overrides)).split('\n')[1]).toBe(expected);
  });

  it('caps the title, each line and the line count', () => {
    const long = 'x'.repeat(500);
    const text = buildContext(input({ titles: new Map([['1.1', long]]) }));
    const nextLine = text.split('\n').find((line) => line.startsWith('Next task:')) ?? '';
    expect(nextLine.length).toBeLessThanOrEqual('Next task: 1.1 '.length + MAX_TITLE_LENGTH);
    expect(nextLine.endsWith('…')).toBe(true);

    const manyRules = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`R-rule-${i}`, '1.1']),
    );
    const capped = buildContext(input({ schedule: schedule(manyRules) }));
    for (const line of capped.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(MAX_LINE_LENGTH);
    }
    expect(capped.split('\n').length).toBeLessThanOrEqual(MAX_LINES);
  });
});

describe('formatOutput', () => {
  it('emits the documented SessionStart JSON shape', () => {
    expect(JSON.parse(formatOutput('a\nb'))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'a\nb' },
    });
  });
});

describe('gatherInput', () => {
  const plan = '- [x] 0.1 Done.\n- [ ] 1.1 Next one.\n';
  const uncovered = JSON.stringify({ $comment: 'x', 'A-rule': { due: '1.1', why: 'y' } });

  function io(overrides: Partial<ContextIo> = {}): ContextIo {
    return {
      readText: (file) => (file === PLAN_PATH ? plan : uncovered),
      git: (args) => (args[0] === 'rev-parse' ? 'main\n' : ' M a.ts\r\n?? b.ts\n\n'),
      ...overrides,
    };
  }

  it('reads git, PLAN and the schedule', () => {
    const gathered = gatherInput(io());
    expect(gathered.branch).toBe('main');
    expect(gathered.dirtyCount).toBe(2);
    expect([...gathered.tasks]).toEqual([
      ['0.1', true],
      ['1.1', false],
    ]);
    expect(gathered.titles.get('1.1')).toBe('Next one.');
    expect(gathered.schedule?.get('A-rule')?.due).toBe('1.1');
  });

  it('degrades git and schedule failures to null', () => {
    const gathered = gatherInput(
      io({
        git: () => {
          throw new Error('no git');
        },
        readText: (file) => (file === PLAN_PATH ? plan : '{not json'),
      }),
    );
    expect(gathered.branch).toBeNull();
    expect(gathered.dirtyCount).toBeNull();
    expect(gathered.schedule).toBeNull();
  });

  it('treats an invalid schedule and an empty branch as unknown', () => {
    const gathered = gatherInput(
      io({
        git: (args) => (args[0] === 'rev-parse' ? '\n' : ''),
        readText: (file) => (file === PLAN_PATH ? plan : '{"X-rule": {"due": "soon"}}'),
      }),
    );
    expect(gathered.branch).toBeNull();
    expect(gathered.dirtyCount).toBe(0);
    expect(gathered.schedule).toBeNull();
  });

  it('throws when PLAN.md is unreadable, so the hook prints nothing', () => {
    expect(() =>
      gatherInput(
        io({
          readText: () => {
            throw new Error('ENOENT');
          },
        }),
      ),
    ).toThrow('ENOENT');
  });
});

describe('the real hook (subprocess)', () => {
  function run(env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [HOOK], {
      cwd: REPO_ROOT,
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8',
      timeout: 15_000,
      env,
    });
  }

  it('exits 0 with valid JSON that names the real next task from docs/PLAN.md', () => {
    const result = run({ ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT });
    expect(result.status).toBe(0);
    const output: unknown = JSON.parse(result.stdout);
    expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: 'SessionStart' } });
    const context = (output as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;

    const planTasks = parsePlanTasks(readFileSync(path.join(REPO_ROOT, PLAN_PATH), 'utf8'));
    const expected = nextTask(planTasks);
    if (expected === null) {
      expect(context).toContain('are ticked');
    } else {
      expect(context).toContain(`Next task: ${expected} `);
    }
    expect(context.split('\n').length).toBeLessThanOrEqual(MAX_LINES);
  });

  it('fails open: prints nothing on stdout and exits 0 when PLAN.md is missing', () => {
    const result = run({
      ...process.env,
      CLAUDE_PROJECT_DIR: path.join(REPO_ROOT, 'no-such-dir'),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('micro-minds session-context: skipped');
  });
});
