// Task 2.3, clauses C2 and C5: the ProviderRegistry. Binary resolution is tested with an injected
// `isFile` and made-up PATH values, never the real PATH or filesystem; normalization with made-up
// adapters that leak secrets, throw or return garbage.
import path from 'node:path';
import type { AgentEvent, Provider } from '@micro-minds/shared';
import { parseAgentEvent, REDACTION_MARKER, scrubRaw, scrubText } from '@micro-minds/shared';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFORMANCE_RECEIVED_AT,
  CONFORMANCE_SEED,
  CONFORMANCE_SESSION_ID,
  makeNormalizeContext,
} from './conformance.test-helpers.ts';
import { EXAMPLE_FIXTURES, exampleAdapter, withOverrides } from './example-adapter.test-helpers.ts';
import { createProviderRegistry } from './registry.ts';
import type { ProviderAdapter } from './types.ts';

type Registry = ReturnType<typeof createProviderRegistry>;

const SESSION_ID = CONFORMANCE_SESSION_ID;
const RECEIVED_AT = CONFORMANCE_RECEIVED_AT;

/** Secrets the scrubber knows, assembled at runtime so no literal key sits in the repo. */
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'Zx9Qw3Er5Ty7Ui1Op2As4Df6Gh8Jk0LmNbVcXz'].join('-');
const GITHUB_TOKEN = ['ghp', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF2gH4'].join('_');

function adapterFor(id: Provider, overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return withOverrides(exampleAdapter(), { id, ...overrides });
}

function withCommand(command: string): ProviderAdapter {
  return adapterFor('fake', { binary: { command, versionArgs: ['--version'] } });
}

function stubNormalize(normalize: ProviderAdapter['normalize']): ProviderAdapter {
  return adapterFor('fake', { normalize });
}

function validEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    v: 1,
    id: '01K6F000000000000000000001',
    ts: RECEIVED_AT,
    sessionId: SESSION_ID,
    provider: 'fake',
    agentId: SESSION_ID,
    kind: 'prompt.submitted',
    ...overrides,
  };
}

describe('createProviderRegistry', () => {
  it('throws when two adapters share an id', () => {
    expect(() => createProviderRegistry([adapterFor('fake'), adapterFor('fake')])).toThrow();
    expect(() =>
      createProviderRegistry([adapterFor('claude'), adapterFor('fake'), adapterFor('claude')]),
    ).toThrow();
  });

  it('accepts an empty list', () => {
    const registry = createProviderRegistry([]);
    expect(registry.list()).toEqual([]);
    expect(registry.get('fake')).toBeUndefined();
  });

  it.each([
    { name: 'fake then claude', ids: ['fake', 'claude'] as const },
    { name: 'claude then fake', ids: ['claude', 'fake'] as const },
    { name: 'three providers', ids: ['codex', 'fake', 'claude'] as const },
  ])('list() returns the adapters in the order given ($name)', ({ ids }) => {
    const adapters = ids.map((id) => adapterFor(id));
    const registry = createProviderRegistry(adapters);
    const listed = registry.list();
    expect(listed.map((a) => a.id)).toEqual([...ids]);
    listed.forEach((adapter, i) => {
      expect(adapter).toBe(adapters[i]);
    });
  });

  it('get(id) returns the registered adapter, and undefined for one not registered', () => {
    const fake = adapterFor('fake');
    const claude = adapterFor('claude');
    const registry = createProviderRegistry([fake, claude]);
    expect(registry.get('fake')).toBe(fake);
    expect(registry.get('claude')).toBe(claude);
    expect(registry.get('gemini')).toBeUndefined();
    expect(registry.get('codex')).toBeUndefined();
  });
});

describe('categorize', () => {
  let registry: Registry;
  beforeEach(() => {
    registry = createProviderRegistry([exampleAdapter()]);
  });

  it.each([
    { name: 'a mapped read tool', id: 'fake', tool: 'Read', expected: 'read' },
    { name: 'a mapped write tool', id: 'fake', tool: 'Write', expected: 'write' },
    { name: 'a mapped exec tool', id: 'fake', tool: 'Bash', expected: 'exec' },
    { name: 'an unmapped tool', id: 'fake', tool: 'Mystery', expected: 'other' },
    { name: 'a different case (exact match only)', id: 'fake', tool: 'read', expected: 'other' },
    { name: 'upper case (exact match only)', id: 'fake', tool: 'BASH', expected: 'other' },
    { name: 'surrounding whitespace', id: 'fake', tool: ' Read ', expected: 'other' },
    { name: 'the empty name', id: 'fake', tool: '', expected: 'other' },
    {
      name: 'an Object.prototype member (toString)',
      id: 'fake',
      tool: 'toString',
      expected: 'other',
    },
    { name: 'constructor', id: 'fake', tool: 'constructor', expected: 'other' },
    { name: '__proto__', id: 'fake', tool: '__proto__', expected: 'other' },
    { name: 'an unknown provider id', id: 'gemini', tool: 'Read', expected: 'other' },
  ] as const)('$name: $tool → $expected', ({ id, tool, expected }) => {
    expect(registry.categorize(id, tool)).toBe(expected);
  });
});

/** An injected filesystem: the given paths exist, compared case-insensitively on win32 (NTFS). */
function fakeFs(platform: NodeJS.Platform, files: readonly string[]) {
  const calls: string[] = [];
  const norm = (p: string) => (platform === 'win32' ? p.toLowerCase() : p);
  const set = new Set(files.map(norm));
  return {
    calls,
    isFile: (absolutePath: string) => {
      calls.push(absolutePath);
      return set.has(norm(absolutePath));
    },
  };
}

describe('resolveBinary on win32', () => {
  let registry: Registry;
  beforeEach(() => {
    registry = createProviderRegistry([withCommand('mmtool')]);
  });
  const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

  it.each([
    {
      name: '.exe is preferred over .cmd in the same directory (PATHEXT order)',
      pathValue: 'C:\\a;C:\\b',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\a\\mmtool.cmd', 'C:\\a\\mmtool.exe'],
      expected: { path: 'C:\\a\\mmtool.exe', kind: 'exe' },
    },
    {
      name: 'PATHEXT order decides: .CMD listed first beats .EXE',
      pathValue: 'C:\\a',
      pathExt: '.CMD;.EXE',
      files: ['C:\\a\\mmtool.cmd', 'C:\\a\\mmtool.exe'],
      expected: { path: 'C:\\a\\mmtool.cmd', kind: 'cmd' },
    },
    {
      name: 'a .cmd in an earlier directory beats an .exe in a later one',
      pathValue: 'C:\\a;C:\\b',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\a\\mmtool.cmd', 'C:\\b\\mmtool.exe'],
      expected: { path: 'C:\\a\\mmtool.cmd', kind: 'cmd' },
    },
    {
      name: 'a later directory is searched when earlier ones lack the command',
      pathValue: 'C:\\a;C:\\b;C:\\c',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\c\\mmtool.exe'],
      expected: { path: 'C:\\c\\mmtool.exe', kind: 'exe' },
    },
    {
      name: '.bat is kind cmd',
      pathValue: 'C:\\a',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\a\\mmtool.bat'],
      expected: { path: 'C:\\a\\mmtool.bat', kind: 'cmd' },
    },
    {
      name: '.com is kind exe',
      pathValue: 'C:\\a',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\a\\mmtool.com'],
      expected: { path: 'C:\\a\\mmtool.com', kind: 'exe' },
    },
    {
      name: 'lower-case PATHEXT entries work (.exe)',
      pathValue: 'C:\\a',
      pathExt: '.exe;.cmd',
      files: ['C:\\a\\MMTOOL.EXE'],
      expected: { path: 'C:\\a\\mmtool.exe', kind: 'exe' },
    },
    {
      name: 'mixed-case PATHEXT entries work (.Cmd is kind cmd)',
      pathValue: 'C:\\a',
      pathExt: '.Exe;.Cmd',
      files: ['C:\\a\\mmtool.cmd'],
      expected: { path: 'C:\\a\\mmtool.cmd', kind: 'cmd' },
    },
    {
      name: 'a trailing backslash on a PATH entry is joined cleanly',
      pathValue: 'C:\\a\\',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\a\\mmtool.exe'],
      expected: { path: 'C:\\a\\mmtool.exe', kind: 'exe' },
    },
    {
      name: 'empty PATH entries are skipped',
      pathValue: ';;C:\\b;',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\b\\mmtool.exe'],
      expected: { path: 'C:\\b\\mmtool.exe', kind: 'exe' },
    },
    {
      name: 'relative PATH entries are skipped even when the command exists there',
      pathValue: 'bin;.;..\\tools;C:\\b',
      pathExt: DEFAULT_PATHEXT,
      files: ['bin\\mmtool.exe', 'mmtool.exe', '..\\tools\\mmtool.exe', 'C:\\b\\mmtool.cmd'],
      expected: { path: 'C:\\b\\mmtool.cmd', kind: 'cmd' },
    },
    {
      name: 'a PATH entry wrapped in double quotes is searched',
      pathValue: 'C:\\a;"C:\\Program Files\\nodejs";C:\\b',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\Program Files\\nodejs\\mmtool.cmd', 'C:\\b\\mmtool.exe'],
      expected: { path: 'C:\\Program Files\\nodejs\\mmtool.cmd', kind: 'cmd' },
    },
    {
      name: 'script extensions in PATHEXT (.JS, .VBS) are skipped for a later .EXE',
      pathValue: 'C:\\a',
      pathExt: '.JS;.VBS;.EXE',
      files: ['C:\\a\\mmtool.js', 'C:\\a\\mmtool.vbs', 'C:\\a\\mmtool.exe'],
      expected: { path: 'C:\\a\\mmtool.exe', kind: 'exe' },
    },
  ])('$name', ({ pathValue, pathExt, files, expected }) => {
    const fs = fakeFs('win32', files);
    const result = registry.resolveBinary('fake', {
      platform: 'win32',
      path: pathValue,
      pathExt,
      isFile: fs.isFile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe(expected.kind);
    expect(path.win32.normalize(result.path).toLowerCase()).toBe(expected.path.toLowerCase());
    for (const call of fs.calls) expect(path.win32.isAbsolute(call)).toBe(true);
  });

  it('keeps the PATHEXT extension case when deciding the kind (.EXE → exe, .CMD → cmd)', () => {
    const exe = registry.resolveBinary('fake', {
      platform: 'win32',
      path: 'C:\\a',
      pathExt: '.EXE',
      isFile: fakeFs('win32', ['C:\\a\\mmtool.exe']).isFile,
    });
    const cmd = registry.resolveBinary('fake', {
      platform: 'win32',
      path: 'C:\\a',
      pathExt: '.CMD',
      isFile: fakeFs('win32', ['C:\\a\\mmtool.cmd']).isFile,
    });
    expect(exe).toMatchObject({ ok: true, kind: 'exe' });
    expect(cmd).toMatchObject({ ok: true, kind: 'cmd' });
  });

  it.each([
    {
      name: '.COM comes before .EXE',
      files: ['C:\\a\\mmtool.exe', 'C:\\a\\mmtool.com'],
      expected: { path: 'C:\\a\\mmtool.com', kind: 'exe' },
    },
    {
      name: '.BAT comes before .CMD',
      files: ['C:\\a\\mmtool.cmd', 'C:\\a\\mmtool.bat'],
      expected: { path: 'C:\\a\\mmtool.bat', kind: 'cmd' },
    },
    {
      name: '.EXE comes before .BAT',
      files: ['C:\\a\\mmtool.bat', 'C:\\a\\mmtool.exe'],
      expected: { path: 'C:\\a\\mmtool.exe', kind: 'exe' },
    },
  ])('a missing pathExt defaults to .COM;.EXE;.BAT;.CMD: $name', ({ files, expected }) => {
    const result = registry.resolveBinary('fake', {
      platform: 'win32',
      path: 'C:\\a',
      isFile: fakeFs('win32', files).isFile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe(expected.kind);
    expect(path.win32.normalize(result.path).toLowerCase()).toBe(expected.path.toLowerCase());
  });

  it('with the default PATHEXT, a file that exists for every candidate resolves to .COM', () => {
    const result = registry.resolveBinary('fake', {
      platform: 'win32',
      path: 'C:\\a',
      isFile: () => true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('exe');
    expect(result.path.toLowerCase()).toBe('c:\\a\\mmtool.com');
  });

  it.each([
    {
      name: 'only the extensionless name exists',
      pathValue: 'C:\\a',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\a\\mmtool'],
    },
    {
      name: 'only an extension missing from PATHEXT exists',
      pathValue: 'C:\\a',
      pathExt: '.EXE;.CMD',
      files: ['C:\\a\\mmtool.bat', 'C:\\a\\mmtool.ps1'],
    },
    {
      name: 'a .ps1 is not in the default PATHEXT',
      pathValue: 'C:\\a',
      pathExt: undefined,
      files: ['C:\\a\\mmtool.ps1'],
    },
    {
      name: 'PATHEXT lists only script extensions (.JS;.VBS;.PS1) and only those files exist',
      pathValue: 'C:\\a',
      pathExt: '.JS;.VBS;.PS1',
      files: ['C:\\a\\mmtool.js', 'C:\\a\\mmtool.vbs', 'C:\\a\\mmtool.ps1'],
    },
    {
      name: 'the command exists only in a relative PATH entry',
      pathValue: 'bin;.',
      pathExt: DEFAULT_PATHEXT,
      files: ['bin\\mmtool.exe', 'mmtool.exe', '.\\mmtool.exe'],
    },
    {
      name: 'the command is nowhere',
      pathValue: 'C:\\a;C:\\b',
      pathExt: DEFAULT_PATHEXT,
      files: [],
    },
    {
      name: 'PATH is empty',
      pathValue: '',
      pathExt: DEFAULT_PATHEXT,
      files: ['C:\\a\\mmtool.exe'],
    },
  ])('not_found when $name', ({ pathValue, pathExt, files }) => {
    const fs = fakeFs('win32', files);
    const result = registry.resolveBinary('fake', {
      platform: 'win32',
      path: pathValue,
      ...(pathExt === undefined ? {} : { pathExt }),
      isFile: fs.isFile,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    for (const call of fs.calls) {
      expect(path.win32.isAbsolute(call)).toBe(true);
      expect(path.win32.extname(call)).not.toBe('');
    }
  });

  it('never asks about the bare extensionless name', () => {
    const fs = fakeFs('win32', []);
    registry.resolveBinary('fake', {
      platform: 'win32',
      path: 'C:\\a;C:\\b',
      pathExt: DEFAULT_PATHEXT,
      isFile: fs.isFile,
    });
    expect(fs.calls.length).toBeGreaterThan(0);
    for (const call of fs.calls) expect(path.win32.basename(call).toLowerCase()).not.toBe('mmtool');
  });

  it('an empty PATH finds nothing even when every file exists (no fallback to the real PATH or cwd)', () => {
    expect(
      registry.resolveBinary('fake', {
        platform: 'win32',
        path: '',
        pathExt: DEFAULT_PATHEXT,
        isFile: () => true,
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe.each(['linux', 'darwin'] as const)('resolveBinary on %s', (platform) => {
  let registry: Registry;
  beforeEach(() => {
    registry = createProviderRegistry([withCommand('mmtool')]);
  });

  it.each([
    {
      name: 'the bare name in a PATH directory',
      pathValue: '/usr/local/bin:/usr/bin',
      files: ['/usr/bin/mmtool'],
      expected: '/usr/bin/mmtool',
    },
    {
      name: 'an earlier directory wins',
      pathValue: '/opt/a:/opt/b',
      files: ['/opt/b/mmtool', '/opt/a/mmtool'],
      expected: '/opt/a/mmtool',
    },
    {
      name: 'a trailing slash on a PATH entry is joined cleanly',
      pathValue: '/opt/tools/',
      files: ['/opt/tools/mmtool'],
      expected: '/opt/tools/mmtool',
    },
    {
      name: 'empty and relative PATH entries are skipped',
      pathValue: 'bin::./x:../y:/usr/bin:',
      files: ['bin/mmtool', 'x/mmtool', './x/mmtool', '../y/mmtool', '/usr/bin/mmtool'],
      expected: '/usr/bin/mmtool',
    },
    {
      name: 'a Windows-style entry is relative here and skipped',
      pathValue: 'C:\\tools:/usr/bin',
      files: ['C:\\tools/mmtool', '/usr/bin/mmtool'],
      expected: '/usr/bin/mmtool',
    },
  ])('$name', ({ pathValue, files, expected }) => {
    const fs = fakeFs(platform, files);
    const result = registry.resolveBinary('fake', { platform, path: pathValue, isFile: fs.isFile });
    expect(result).toEqual({ ok: true, path: expected, kind: 'posix' });
    for (const call of fs.calls) expect(path.posix.isAbsolute(call)).toBe(true);
  });

  it.each([
    {
      name: 'only .exe/.cmd variants exist (bare name only here)',
      pathValue: '/usr/bin',
      pathExt: '.EXE;.CMD',
      files: ['/usr/bin/mmtool.exe', '/usr/bin/mmtool.cmd', '/usr/bin/mmtool.EXE'],
    },
    {
      name: "';' does not split PATH here",
      pathValue: '/a;/b',
      pathExt: undefined,
      files: ['/b/mmtool', '/a/mmtool'],
    },
    {
      name: 'the command exists only in a relative entry',
      pathValue: 'bin:.',
      pathExt: undefined,
      files: ['bin/mmtool', 'mmtool', './mmtool'],
    },
    { name: 'PATH is empty', pathValue: '', pathExt: undefined, files: ['/usr/bin/mmtool'] },
  ])('not_found when $name', ({ pathValue, pathExt, files }) => {
    const fs = fakeFs(platform, files);
    const result = registry.resolveBinary('fake', {
      platform,
      path: pathValue,
      ...(pathExt === undefined ? {} : { pathExt }),
      isFile: fs.isFile,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('asks only about the bare name, never an extension', () => {
    const fs = fakeFs(platform, []);
    registry.resolveBinary('fake', {
      platform,
      path: '/a:/b',
      pathExt: '.EXE;.CMD',
      isFile: fs.isFile,
    });
    expect(fs.calls).toEqual(['/a/mmtool', '/b/mmtool']);
  });
});

describe.each(['win32', 'linux', 'darwin'] as const)(
  'resolveBinary rejects unsafe commands on %s',
  (platform) => {
    it.each([
      { name: 'a forward slash', command: 'bin/mmtool' },
      { name: 'a backslash', command: 'bin\\mmtool' },
      { name: "'..' alone", command: '..' },
      { name: "a '../' prefix", command: '../mmtool' },
      { name: "a '..\\' prefix", command: '..\\mmtool' },
      { name: 'an absolute POSIX path', command: '/usr/bin/mmtool' },
      { name: 'an absolute Windows path', command: 'C:\\tools\\mmtool' },
      { name: "an embedded '..'", command: 'mm..tool' },
    ])('a command with $name is never resolved', ({ command }) => {
      const registry = createProviderRegistry([withCommand(command)]);
      const result = registry.resolveBinary('fake', {
        platform,
        path: platform === 'win32' ? 'C:\\a;C:\\b' : '/a:/b',
        pathExt: '.COM;.EXE;.BAT;.CMD',
        isFile: () => true,
      });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('an unregistered provider is unknown_provider', () => {
      const registry = createProviderRegistry([withCommand('mmtool')]);
      const result = registry.resolveBinary('gemini', {
        platform,
        path: platform === 'win32' ? 'C:\\a' : '/a',
        isFile: () => true,
      });
      expect(result).toEqual({ ok: false, reason: 'unknown_provider' });
    });
  },
);

/** Asserts the value is the registry's fallback event for the root agent. */
function expectFallback(event: AgentEvent | undefined, issued: readonly string[]): void {
  expect(event).toBeDefined();
  if (event === undefined) return;
  expect(parseAgentEvent(event).ok).toBe(true);
  expect(event.kind).toBe('unknown');
  expect(event.agentId).toBe(SESSION_ID);
  expect(event.parentAgentId).toBeUndefined();
  expect(event.sessionId).toBe(SESSION_ID);
  expect(event.provider).toBe('fake');
  expect(event.ts).toBe(RECEIVED_AT);
  expect(issued).toContain(event.id);
}

function expectAllStorable(events: readonly AgentEvent[]): void {
  for (const event of events) {
    expect(parseAgentEvent(event).ok).toBe(true);
    expect(() => JSON.stringify(event)).not.toThrow();
  }
}

describe('normalize: valid adapter output passes through', () => {
  it.each(EXAMPLE_FIXTURES.map((raw, i) => ({ name: `example fixture #${i}`, raw })))(
    '$name gives the same events as the adapter itself',
    ({ raw }) => {
      const registry = createProviderRegistry([exampleAdapter()]);
      const viaRegistry = makeNormalizeContext();
      const direct = makeNormalizeContext();
      const out = registry.normalize('fake', raw, viaRegistry.ctx);
      expect(out).toEqual(exampleAdapter().normalize(raw, direct.ctx));
      expectAllStorable(out);
    },
  );

  it('passes the context through: ids come from ctx.newId() and ts from ctx.receivedAt', () => {
    const registry = createProviderRegistry([exampleAdapter()]);
    const { ctx, issued } = makeNormalizeContext();
    const out = registry.normalize('fake', { event: 'tool.started', tool: 'Read' }, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.ts).toBe(RECEIVED_AT);
    expect(issued).toContain(out[0]?.id);
  });
});

describe('normalize: scrubbing', () => {
  const leaky = stubNormalize((_raw, ctx) => [
    validEvent({
      id: ctx.newId(),
      kind: 'tool.started',
      text: `using key ${ANTHROPIC_KEY} now`,
      tool: {
        name: 'Bash',
        category: 'exec',
        summary: `git push https://${GITHUB_TOKEN}@github.com`,
      },
      raw: {
        tool_input: { command: `export TOKEN=${GITHUB_TOKEN}` },
        note: `key ${ANTHROPIC_KEY}`,
        nested: [{ deeper: `Bearer ${ANTHROPIC_KEY}` }],
      },
    }),
  ]);

  it('no planted secret survives in text, tool.summary or raw', () => {
    const registry = createProviderRegistry([leaky]);
    const out = registry.normalize('fake', {}, makeNormalizeContext().ctx);
    expect(out).toHaveLength(1);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(ANTHROPIC_KEY);
    expect(serialized).not.toContain(GITHUB_TOKEN);
    expectAllStorable(out);
  });

  it('text and tool.summary are exactly what scrubText makes of them', () => {
    const registry = createProviderRegistry([leaky]);
    const [event] = registry.normalize('fake', {}, makeNormalizeContext().ctx);
    expect(event?.text).toBe(scrubText(`using key ${ANTHROPIC_KEY} now`));
    expect(event?.text).toContain(REDACTION_MARKER);
    expect(event?.tool?.summary).toBe(scrubText(`git push https://${GITHUB_TOKEN}@github.com`));
    expect(event?.tool?.summary).toContain(REDACTION_MARKER);
  });

  it('a small raw is what scrubRaw makes of it (redacted, structure kept)', () => {
    const raw = { note: `key ${ANTHROPIC_KEY}`, list: ['plain', `tok ${GITHUB_TOKEN}`] };
    const registry = createProviderRegistry([
      stubNormalize((_r, ctx) => [validEvent({ id: ctx.newId(), raw })]),
    ]);
    const [event] = registry.normalize('fake', {}, makeNormalizeContext().ctx);
    expect(event?.raw).toEqual(scrubRaw(raw, { maxLength: Number.POSITIVE_INFINITY }));
  });

  it('an oversized raw is capped', () => {
    const huge = { output: 'y'.repeat(4_000_000) };
    const registry = createProviderRegistry([
      stubNormalize((_r, ctx) => [validEvent({ id: ctx.newId(), raw: huge })]),
    ]);
    const [event] = registry.normalize('fake', {}, makeNormalizeContext().ctx);
    expect(event).toBeDefined();
    expect(JSON.stringify(event?.raw ?? null).length).toBeLessThanOrEqual(1_048_576);
  });

  it('a circular raw still yields a storable event', () => {
    const raw: Record<string, unknown> = { name: 'loop' };
    raw.self = raw;
    const registry = createProviderRegistry([
      stubNormalize((_r, ctx) => [validEvent({ id: ctx.newId(), raw })]),
    ]);
    const out = registry.normalize('fake', {}, makeNormalizeContext().ctx);
    expect(out).toHaveLength(1);
    expectAllStorable(out);
  });
});

describe('normalize: a misbehaving adapter yields unknown events', () => {
  const secretRaw = { hook_event_name: 'PreToolUse', message: `token ${GITHUB_TOKEN} here` };

  it.each([
    {
      name: 'an adapter that throws an Error',
      normalize: (): AgentEvent[] => {
        throw new Error(`failed on ${ANTHROPIC_KEY}`);
      },
    },
    {
      name: 'an adapter that throws a non-Error',
      normalize: (): AgentEvent[] => {
        throw 'plain string';
      },
    },
    {
      name: 'an adapter that throws after taking an id',
      normalize: (_raw: unknown, ctx: { newId: () => string }): AgentEvent[] => {
        ctx.newId();
        throw new TypeError('half way');
      },
    },
    { name: 'an adapter that returns an object', normalize: () => ({}) as unknown as AgentEvent[] },
    { name: 'an adapter that returns null', normalize: () => null as unknown as AgentEvent[] },
    {
      name: 'an adapter that returns undefined',
      normalize: () => undefined as unknown as AgentEvent[],
    },
    {
      name: 'an adapter that returns a string',
      normalize: () => 'events' as unknown as AgentEvent[],
    },
  ])('$name → exactly one unknown event for the root agent', ({ normalize }) => {
    const registry = createProviderRegistry([stubNormalize(normalize)]);
    const { ctx, issued } = makeNormalizeContext();
    let out: AgentEvent[] = [];
    expect(() => {
      out = registry.normalize('fake', secretRaw, ctx);
    }).not.toThrow();
    expect(out).toHaveLength(1);
    expectFallback(out[0], issued);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(GITHUB_TOKEN);
    expect(serialized).not.toContain(ANTHROPIC_KEY);
  });

  it('the fallback event keeps the raw input, scrubbed', () => {
    const registry = createProviderRegistry([
      stubNormalize(() => {
        throw new Error('boom');
      }),
    ]);
    const [event] = registry.normalize('fake', secretRaw, makeNormalizeContext().ctx);
    expect(event?.raw).toBeDefined();
    const serialized = JSON.stringify(event?.raw);
    expect(serialized).toContain('PreToolUse');
    expect(serialized).toContain(REDACTION_MARKER);
    expect(serialized).not.toContain(GITHUB_TOKEN);
  });

  const throwingGetter = Object.defineProperty({}, 'kind', {
    enumerable: true,
    get: () => {
      throw new Error('getter');
    },
  });

  it.each([
    { name: 'null', bad: null },
    { name: 'a number', bad: 42 },
    { name: 'an empty object', bad: {} },
    { name: 'a missing id', bad: { ...validEvent(), id: undefined } },
    { name: 'a non-ULID id', bad: validEvent({ id: 'not-a-ulid' }) },
    { name: 'a missing schema version', bad: { ...validEvent(), v: undefined } },
    { name: 'an unsupported schema version', bad: { ...validEvent(), v: 99 } },
    { name: 'an invalid provider', bad: { ...validEvent(), provider: 'openai' } },
    {
      name: 'an invalid tool category',
      bad: { ...validEvent(), kind: 'tool.started', tool: { name: 'Read', category: 'reading' } },
    },
    { name: 'a negative ts', bad: validEvent({ ts: -5 }) },
    { name: 'an object whose getter throws', bad: throwingGetter },
  ])('an invalid event ($name) is replaced by an unknown event, its neighbors kept', ({ bad }) => {
    const registry = createProviderRegistry([
      stubNormalize(
        (_raw, ctx) =>
          [
            validEvent({ id: ctx.newId(), kind: 'prompt.submitted' }),
            bad,
            validEvent({ id: ctx.newId(), kind: 'turn.finished' }),
          ] as unknown as AgentEvent[],
      ),
    ]);
    const { ctx, issued } = makeNormalizeContext();
    let out: AgentEvent[] = [];
    expect(() => {
      out = registry.normalize('fake', secretRaw, ctx);
    }).not.toThrow();
    expect(out).toHaveLength(3);
    expect(out[0]?.kind).toBe('prompt.submitted');
    expectFallback(out[1], issued);
    expect(out[2]?.kind).toBe('turn.finished');
    expect(new Set(out.map((e) => e.id)).size).toBe(3);
    expectAllStorable(out);
  });

  it('a clock.tick from an adapter is replaced by an unknown event (time comes only from the server, D15)', () => {
    const tick = validEvent({ kind: 'clock.tick' });
    expect(parseAgentEvent(tick).ok).toBe(true);
    const registry = createProviderRegistry([
      stubNormalize((_raw, ctx) => [
        validEvent({ id: ctx.newId(), kind: 'prompt.submitted' }),
        { ...tick, id: ctx.newId() },
        validEvent({ id: ctx.newId(), kind: 'turn.finished' }),
      ]),
    ]);
    const { ctx, issued } = makeNormalizeContext();
    const out = registry.normalize('fake', secretRaw, ctx);
    expect(out.map((e) => e.kind)).toEqual(['prompt.submitted', 'unknown', 'turn.finished']);
    expectFallback(out[1], issued);
    expectAllStorable(out);
  });

  it.each([
    {
      name: 'a revoked Proxy',
      make: (): AgentEvent[] => {
        const { proxy, revoke } = Proxy.revocable<AgentEvent[]>([], {});
        revoke();
        return proxy;
      },
    },
    {
      name: 'an array Proxy whose length getter throws',
      make: (): AgentEvent[] =>
        new Proxy<AgentEvent[]>([validEvent()], {
          get: (target, key, receiver) => {
            if (key === 'length') throw new Error('length');
            return Reflect.get(target, key, receiver);
          },
        }),
    },
  ])('an adapter returning $name → exactly one unknown event, no throw', ({ make }) => {
    const registry = createProviderRegistry([stubNormalize(() => make())]);
    const { ctx, issued } = makeNormalizeContext();
    let out: AgentEvent[] = [];
    expect(() => {
      out = registry.normalize('fake', secretRaw, ctx);
    }).not.toThrow();
    expect(out).toHaveLength(1);
    expectFallback(out[0], issued);
  });

  it('an unknown provider id returns [] and never calls an adapter', () => {
    let calls = 0;
    const registry = createProviderRegistry([
      stubNormalize((raw, ctx) => {
        calls += 1;
        return exampleAdapter().normalize(raw, ctx);
      }),
    ]);
    expect(
      registry.normalize('gemini', { event: 'turn.finished' }, makeNormalizeContext().ctx),
    ).toEqual([]);
    expect(registry.normalize('claude', secretRaw, makeNormalizeContext().ctx)).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('normalize never throws (property)', () => {
  const adapters: readonly { name: string; adapter: ProviderAdapter }[] = [
    { name: 'the example adapter', adapter: exampleAdapter() },
    {
      name: 'an adapter that always throws',
      adapter: stubNormalize(() => {
        throw new Error('always');
      }),
    },
    {
      name: 'an adapter that echoes its input as events',
      adapter: stubNormalize((raw) => raw as AgentEvent[]),
    },
    {
      name: 'an adapter that returns its input twice in an array',
      adapter: stubNormalize((raw) => [raw, raw] as AgentEvent[]),
    },
  ];

  it.each(adapters)('$name: any input gives an array of storable events', ({ adapter }) => {
    const registry = createProviderRegistry([adapter]);
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withSparseArray: true }), (raw) => {
        const { ctx, issued } = makeNormalizeContext();
        const out = registry.normalize('fake', raw, ctx);
        expect(Array.isArray(out)).toBe(true);
        for (const event of out) {
          expect(parseAgentEvent(event).ok).toBe(true);
          expect(event.sessionId).toBe(SESSION_ID);
        }
        for (const event of out.filter((e) => e.kind === 'unknown' && e.agentId === SESSION_ID)) {
          expect(event.ts).toBe(RECEIVED_AT);
          expect(issued).toContain(event.id);
        }
      }),
      { seed: CONFORMANCE_SEED, numRuns: 200 },
    );
  });
});
