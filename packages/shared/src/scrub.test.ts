// Task 2.2: the scrubber's corpus of secret shapes and negatives (PLAN §9 item 5, §11, D14).
// Clauses 1–7 and 10. The fast-check properties (clauses 8–10) are in scrub.property.test.ts.
//
// Public surface under test (packages/shared/src/index.ts):
//   REDACTION_MARKER: string                                  the text that replaces a secret
//   scrubText(text: string): string                           clauses 1–6, 10
//   scrubRaw(value: unknown, options: { maxLength: number }): unknown   clause 7, 10
// Size is measured as the length of JSON.stringify(result); the tests use ASCII only, so
// characters and bytes agree.
import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, scrubRaw, scrubText } from './index.ts';
import {
  ALNUM,
  BASE64,
  BASE64URL,
  HIGH_ENTROPY_SHAPE,
  highEntropyToken,
  KNOWN_SHAPES,
  PLAIN_ENV_LINES,
  SOURCE_LINES,
} from './scrub.test-helpers.ts';

const M = REDACTION_MARKER;
const SEEDS = [1, 2, 3, 20_260_928] as const;

/** Built at runtime so the file holds no token-shaped literal. */
function sample(shapeName: string, seed = 7): string {
  const shape = KNOWN_SHAPES.find((candidate) => candidate.name.startsWith(shapeName));
  if (shape === undefined) throw new Error(`no shape ${shapeName}`);
  return shape.make(seed).secret;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('REDACTION_MARKER', () => {
  it('is a non-empty string exported from the package surface', () => {
    expect(typeof REDACTION_MARKER).toBe('string');
    expect(REDACTION_MARKER.length).toBeGreaterThan(0);
  });
});

describe('scrubText: known secret shapes (clause 1)', () => {
  const rows = KNOWN_SHAPES.flatMap((shape) =>
    SEEDS.map((seed) => ({ name: `${shape.name} #${seed}`, ...shape.make(seed) })),
  );

  it.each(rows)('$name on its own → the redaction marker', ({ secret }) => {
    expect(scrubText(secret)).toBe(M);
  });

  it.each(rows)('$name inside a sentence → only the secret is replaced', ({ secret, core }) => {
    const out = scrubText(`Found ${secret} in the log.`);
    expect(out).toBe(`Found ${M} in the log.`);
    expect(out).not.toContain(core);
  });
});

describe('scrubText: bearer tokens (clause 2)', () => {
  const opaque = highEntropyToken(11, 32, BASE64URL);
  const jwt = sample('JWT');
  const rows = [
    {
      name: 'Authorization header with an opaque token',
      input: `Authorization: Bearer ${opaque}`,
      expected: `Authorization: Bearer ${M}`,
      token: opaque,
    },
    {
      name: 'Authorization header with a JWT',
      input: `Authorization: Bearer ${jwt}`,
      expected: `Authorization: Bearer ${M}`,
      token: jwt,
    },
    {
      name: 'a short, low-entropy token still counts',
      input: 'Authorization: Bearer abc123def456',
      expected: `Authorization: Bearer ${M}`,
      token: 'abc123def456',
    },
    {
      name: 'lower-case header and scheme keep their case',
      input: `authorization: bearer ${opaque}`,
      expected: `authorization: bearer ${M}`,
      token: opaque,
    },
    {
      name: 'inside a curl command, the rest of the command is kept',
      input: `curl -H "Authorization: Bearer ${opaque}" https://api.example.com/v1/models`,
      expected: `curl -H "Authorization: Bearer ${M}" https://api.example.com/v1/models`,
      token: opaque,
    },
    {
      name: 'inside a JSON headers object',
      input: `{"headers":{"authorization":"Bearer ${opaque}","accept":"application/json"}}`,
      expected: `{"headers":{"authorization":"Bearer ${M}","accept":"application/json"}}`,
      token: opaque,
    },
  ];

  it.each(rows)('$name', ({ input, expected, token }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(token);
  });
});

describe('scrubText: secret KEY=value lines in env-like content (clause 3)', () => {
  const rows = [
    { name: 'KEY', input: 'API_KEY=hunter2', keep: 'API_KEY=', value: 'hunter2' },
    {
      name: '…_API_KEY',
      input: 'ANTHROPIC_API_KEY=hunter2',
      keep: 'ANTHROPIC_API_KEY=',
      value: 'hunter2',
    },
    {
      name: 'TOKEN with export',
      input: 'export GITHUB_TOKEN=plain-token-value',
      keep: 'export GITHUB_TOKEN=',
      value: 'plain-token-value',
    },
    {
      name: 'SECRET with spaces around =',
      input: 'CLIENT_SECRET = hunter2',
      keep: 'CLIENT_SECRET =',
      value: 'hunter2',
    },
    {
      name: 'secret key in double quotes',
      input: 'AWS_SECRET_ACCESS_KEY="hunter2"',
      keep: 'AWS_SECRET_ACCESS_KEY=',
      value: 'hunter2',
    },
    {
      name: 'PASSWORD in single quotes with spaces',
      input: "DB_PASSWORD='correct horse battery staple'",
      keep: 'DB_PASSWORD=',
      value: 'correct horse battery staple',
    },
    { name: 'bare PASSWORD', input: 'PASSWORD=hunter2', keep: 'PASSWORD=', value: 'hunter2' },
    {
      name: 'CREDENTIALS',
      input: 'SERVICE_CREDENTIALS=hunter2',
      keep: 'SERVICE_CREDENTIALS=',
      value: 'hunter2',
    },
    {
      name: 'export, spaces and quotes together',
      input: 'export DATABASE_PASSWORD = "p@ss w0rd!"',
      keep: 'export DATABASE_PASSWORD =',
      value: 'p@ss w0rd!',
    },
    {
      name: 'lower-case key',
      input: 'db_password=hunter2',
      keep: 'db_password=',
      value: 'hunter2',
    },
    {
      name: 'indented line',
      input: '  AUTH_TOKEN=hunter2',
      keep: '  AUTH_TOKEN=',
      value: 'hunter2',
    },
  ];

  it.each(rows)('$name → value redacted, key kept', ({ input, keep, value }) => {
    const out = scrubText(input);
    expect(out.startsWith(keep)).toBe(true);
    expect(out).toContain(M);
    expect(out).not.toContain(value);
  });

  it('a whole .env file: secret values replaced, every other line kept as it was', () => {
    const input = [
      '# local settings',
      'NODE_ENV=development',
      'PORT=3000',
      'API_KEY=hunter2',
      'export GITHUB_TOKEN=plain-token-value',
      'DATABASE_URL=postgres://localhost:5432/app',
      'DB_PASSWORD=correct-horse',
      'LOG_LEVEL=debug',
      '',
    ].join('\n');
    const expected = [
      '# local settings',
      'NODE_ENV=development',
      'PORT=3000',
      `API_KEY=${M}`,
      `export GITHUB_TOKEN=${M}`,
      'DATABASE_URL=postgres://localhost:5432/app',
      `DB_PASSWORD=${M}`,
      'LOG_LEVEL=debug',
      '',
    ].join('\n');
    expect(scrubText(input)).toBe(expected);
  });

  it('CRLF line endings are kept and the value does not swallow the \\r', () => {
    const input = 'NODE_ENV=production\r\nAPI_KEY=hunter2\r\nPORT=3000\r\n';
    expect(scrubText(input)).toBe(`NODE_ENV=production\r\nAPI_KEY=${M}\r\nPORT=3000\r\n`);
  });

  it('a known-shape value on a secret key is gone and the key is kept', () => {
    const token = sample('GitHub personal');
    const out = scrubText(`GITHUB_TOKEN=${token}`);
    expect(out).toBe(`GITHUB_TOKEN=${M}`);
  });
});

describe('scrubText: high-entropy strings with no known shape (clause 4)', () => {
  const rows = [
    { name: '40 mixed-case alphanumerics', token: highEntropyToken(101, 40, ALNUM) },
    { name: '64 mixed-case alphanumerics', token: highEntropyToken(102, 64, ALNUM) },
    { name: '40 base64 chars with + and /', token: highEntropyToken(103, 40, BASE64) },
    { name: '48 base64url chars with - and _', token: highEntropyToken(104, 48, BASE64URL) },
    ...SEEDS.map((seed) => ({
      name: `generated high-entropy token #${seed}`,
      token: HIGH_ENTROPY_SHAPE.make(seed).secret,
    })),
  ];

  it.each(rows)('$name on its own → the redaction marker', ({ token }) => {
    expect(scrubText(token)).toBe(M);
  });

  it.each(rows)('$name in a line of text → only the token is replaced', ({ token }) => {
    expect(scrubText(`session secret: ${token} (rotated)`)).toBe(`session secret: ${M} (rotated)`);
  });
});

describe('scrubText: only the secret is replaced (clause 5)', () => {
  const ant = sample('Anthropic');
  const ghp = sample('GitHub personal');
  const google = sample('Google');
  const aws = sample('AWS');
  const pemKey = sample('PEM RSA');
  const rows = [
    { name: 'at the start', input: `${ant} was pasted here`, expected: `${M} was pasted here` },
    { name: 'at the end', input: `the key is ${ant}`, expected: `the key is ${M}` },
    {
      name: 'in a JSON string value',
      input: `{"apiKey":"${ant}","model":"claude-opus-5-5"}`,
      expected: `{"apiKey":"${M}","model":"claude-opus-5-5"}`,
    },
    {
      name: 'in a URL query parameter',
      input: `GET https://maps.example.com/api?key=${google}&zoom=3`,
      expected: `GET https://maps.example.com/api?key=${M}&zoom=3`,
    },
    {
      name: 'several secrets in one text',
      input: `gh: ${ghp}\naws: ${aws}\nnothing else here`,
      expected: `gh: ${M}\naws: ${M}\nnothing else here`,
    },
    {
      name: 'a PEM block between other lines',
      input: `Reading id_rsa:\n${pemKey}\nDone (3 lines).`,
      expected: `Reading id_rsa:\n${M}\nDone (3 lines).`,
    },
    {
      name: 'a secret inside a shell command',
      input: `git status && echo ${ghp} | gh auth login --with-token`,
      expected: `git status && echo ${M} | gh auth login --with-token`,
    },
  ];

  it.each(rows)('$name', ({ input, expected }) => {
    expect(scrubText(input)).toBe(expected);
  });
});

describe('scrubText: ordinary text is left unchanged (clause 6, the negative corpus)', () => {
  const rows: { name: string; input: string }[] = [
    { name: 'prose', input: 'The quick brown fox jumps over the lazy dog.' },
    {
      name: 'prose with numbers',
      input: 'Refactored the reducer so health is derived in one place; all 42 tests pass.',
    },
    {
      name: 'prose that mentions keys and secrets',
      input: 'Rotate the API key, then update the secret in the password manager.',
    },
    { name: 'prose using the word bearer', input: 'She was the bearer of bad news.' },
    { name: 'unicode prose', input: 'Grüße aus Zürich — naïve café, 日本語のテキスト 🚀' },
    {
      name: 'markdown',
      input: '## Plan\n\n- Read `docs/PLAN.md` first.\n- Run `npm run check` before committing.\n',
    },
    ...SOURCE_LINES.map((line) => ({ name: `source code: ${line}`, input: line })),
    {
      name: 'a block of source code',
      input: [
        'export function scrubAll(values: readonly string[]): string[] {',
        '  const results: string[] = [];',
        '  for (const value of values) results.push(value.trim());',
        '  return results;',
        '}',
      ].join('\n'),
    },
    {
      name: 'Windows path',
      input: 'C:\\Users\\dev\\projects\\micro-minds\\packages\\shared\\src\\index.ts',
    },
    {
      name: 'Windows path to a .cmd shim',
      input: 'D:\\a\\micro-minds\\micro-minds\\node_modules\\.bin\\vitest.cmd',
    },
    { name: 'Windows UNC path', input: '\\\\server\\share\\reports\\2026-09-28.csv' },
    {
      name: 'POSIX path',
      input: '/home/dev/projects/micro-minds/apps/server/src/providers/claude/adapter.ts',
    },
    { name: 'POSIX path under /usr', input: '/usr/local/lib/node_modules/npm/bin/npm-cli.js' },
    {
      name: 'worktree path with a ULID',
      input: '~/.micro-minds/worktrees/01K6A2B3C4D5E6F7G8H9J0K1M2/packages/web',
    },
    { name: 'URL', input: 'https://github.com/enbattle/micro-minds/pull/12' },
    {
      name: 'URL with a fragment',
      input: 'https://docs.anthropic.com/en/docs/claude-code/hooks#hook-input',
    },
    { name: 'loopback URL with a port', input: 'http://127.0.0.1:4317/v1/logs' },
    {
      name: 'URL with an ordinary query',
      input: 'https://www.npmjs.com/package/fast-check?activeTab=versions',
    },
    {
      name: 'URL whose query mentions a secret',
      input: 'https://example.com/search?q=secret+rotation&page=2',
    },
    { name: 'UUID', input: '550e8400-e29b-41d4-a716-446655440000' },
    { name: 'upper-case UUID', input: 'F47AC10B-58CC-4372-A567-0E02B2C3D479' },
    { name: 'ULID', input: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    { name: 'ULID session id', input: 'session 01K6A2B3C4D5E6F7G8H9J0K1M2 started' },
    { name: 'short git hash', input: 'commit 2d8c3a8' },
    { name: 'full SHA-1 git hash', input: '9fceb02d0ae598e95dc970b74767f19372d61af8' },
    {
      name: 'SHA-256 git hash',
      input: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    {
      name: 'git log line',
      input:
        '2d8c3a8 feat(shared): add event schemas, severity rules and the world-state reducer (2.1)',
    },
    { name: 'ms epoch', input: '1790000000000' },
    { name: 'decimal', input: '3.14159' },
    { name: 'negative integer', input: '-42' },
    { name: 'grouped number', input: '1,234,567' },
    { name: 'ISO timestamp', input: '2026-09-28T12:34:56.789Z' },
    { name: 'HTTP date', input: 'Mon, 28 Sep 2026 12:34:56 GMT' },
    { name: 'durations', input: 'took 1.5s (p95 230ms)' },
    ...PLAIN_ENV_LINES.map((line) => ({ name: `non-secret env line: ${line}`, input: line })),
    { name: 'a non-secret env file', input: `${PLAIN_ENV_LINES.join('\n')}\n` },
    { name: 'empty string', input: '' },
    { name: 'whitespace only', input: ' \n\t\r\n ' },
  ];

  it.each(rows)('$name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

describe('scrubRaw: structured values (clause 7)', () => {
  const ant = sample('Anthropic');
  const ghp = sample('GitHub personal');
  const bearer = highEntropyToken(12, 32, BASE64URL);
  const BIG = { maxLength: 1_000_000 };

  function payload(): Record<string, unknown> {
    return {
      session_id: '01K6A2B3C4D5E6F7G8H9J0K1M2',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: `curl -H "Authorization: Bearer ${bearer}" https://api.example.com/v1/models`,
        description: 'List models',
      },
      tool_response: {
        stdout: 'API_KEY=hunter2\nPORT=3000\n',
        stderr: '',
        exit_code: 0,
        interrupted: false,
      },
      env: [`GITHUB_TOKEN=${ghp}`, 'NODE_ENV=production', 42, null, true, [`nested ${ant}`]],
    };
  }

  it('scrubs every string in nested objects and arrays and keeps everything else', () => {
    expect(scrubRaw(payload(), BIG)).toEqual({
      session_id: '01K6A2B3C4D5E6F7G8H9J0K1M2',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: `curl -H "Authorization: Bearer ${M}" https://api.example.com/v1/models`,
        description: 'List models',
      },
      tool_response: {
        stdout: `API_KEY=${M}\nPORT=3000\n`,
        stderr: '',
        exit_code: 0,
        interrupted: false,
      },
      env: [`GITHUB_TOKEN=${M}`, 'NODE_ENV=production', 42, null, true, [`nested ${M}`]],
    });
  });

  it.each([
    {
      name: 'a top-level string',
      input: `Authorization: Bearer ${bearer}`,
      expected: `Authorization: Bearer ${M}`,
    },
    { name: 'a top-level array', input: [ghp, 'ok'], expected: [M, 'ok'] },
    { name: 'a number', input: 7, expected: 7 },
    { name: 'a boolean', input: false, expected: false },
    { name: 'null', input: null, expected: null },
  ])('$name', ({ input, expected }) => {
    expect(scrubRaw(input, BIG)).toEqual(expected);
  });

  it('does not mutate its input (deep-frozen input, compared before and after)', () => {
    const input = deepFreeze(payload());
    const before = structuredClone(input);
    const out = scrubRaw(input, BIG);
    expect(input).toEqual(before);
    expect(out).not.toBe(input);
    expect(JSON.stringify(input)).toContain(ghp);
  });

  it('a value exactly at the cap is kept whole', () => {
    const value = { note: 'x'.repeat(100) };
    const cap = JSON.stringify(value).length;
    const out = scrubRaw(value, { maxLength: cap });
    expect(out).toEqual(value);
  });

  it('a value one character over the cap is truncated and marked as truncated', () => {
    const value = { note: 'x'.repeat(100) };
    const cap = JSON.stringify(value).length - 1;
    const out = scrubRaw(value, { maxLength: cap });
    expect(out).toMatchObject({ truncated: true });
  });

  it.each([256, 1_000, 4_096])(
    'over a cap of %i: truncated, marked, within the cap, JSON-serializable, keeps its start',
    (maxLength) => {
      const value = {
        hook_event_name: 'PreToolUse',
        tool_response: { content: 'lorem ipsum dolor sit amet '.repeat(5_000) },
      };
      const out = scrubRaw(value, { maxLength });
      expect(out).toMatchObject({ truncated: true });
      const json = JSON.stringify(out);
      expect(json.length).toBeLessThanOrEqual(maxLength);
      expect(JSON.parse(json)).toEqual(out);
      expect(json).toContain('PreToolUse');
    },
  );

  it('a truncated result holds no secret from the input', () => {
    const value = {
      hook_event_name: 'PostToolUse',
      content: `API_KEY=hunter2\n${ghp}\nAuthorization: Bearer ${bearer}\n${'filler text '.repeat(2_000)}`,
    };
    const json = JSON.stringify(scrubRaw(value, { maxLength: 600 }));
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain(ghp.slice(4, 20));
    expect(json).not.toContain(bearer.slice(0, 16));
  });

  it.each([0, 10, 40, 80, 120])(
    'a long secret straddling the cut point leaves no fragment (secret starts %i chars before the cap)',
    (back) => {
      const project = sample('OpenAI project');
      const maxLength = 500;
      const lead = 'a'.repeat(Math.max(0, maxLength - back - 20));
      const value = { text: `${lead} ${project} ${'tail '.repeat(500)}` };
      const json = JSON.stringify(scrubRaw(value, { maxLength }));
      const body = project.slice('sk-proj-'.length);
      for (let i = 0; i + 12 <= body.length; i += 6) {
        expect(json).not.toContain(body.slice(i, i + 12));
      }
    },
  );
});

describe('the scrubbers never throw and are deterministic (clause 10)', () => {
  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;
  let deep: unknown = 'bottom';
  for (let i = 0; i < 10_000; i++) deep = [deep];
  const throwingGetter = Object.defineProperty({}, 'boom', {
    enumerable: true,
    get() {
      throw new Error('getter throws');
    },
  });

  const odd: { name: string; value: unknown }[] = [
    { name: 'undefined', value: undefined },
    { name: 'null', value: null },
    { name: 'a number', value: 42 },
    { name: 'NaN', value: Number.NaN },
    { name: 'a bigint', value: 10n },
    { name: 'a symbol', value: Symbol('s') },
    { name: 'a function', value: () => 1 },
    { name: 'a Date', value: new Date(0) },
    { name: 'a Map', value: new Map([['k', 'v']]) },
    { name: 'an object with a null prototype', value: Object.create(null) },
    { name: 'a circular object', value: circular },
    { name: 'a 10 000-level nested array', value: deep },
    { name: 'an object whose getter throws', value: throwingGetter },
    { name: 'a lone surrogate', value: 'abc\uD800def' },
    { name: '1 MB of one letter', value: 'a'.repeat(1_000_000) },
    { name: '200 000 dashes (PEM-like)', value: '-'.repeat(200_000) },
    { name: 'a repeated JWT prefix', value: 'eyJ.'.repeat(100_000) },
    { name: 'a repeated env prefix', value: 'API_KEY='.repeat(50_000) },
    { name: 'a repeated bearer prefix', value: 'Bearer '.repeat(50_000) },
  ];

  const scrubTextLoose = scrubText as unknown as (input: unknown) => unknown;

  it.each(odd)('scrubText does not throw on $name', ({ value }) => {
    expect(() => scrubTextLoose(value)).not.toThrow();
  });

  it.each(odd)('scrubRaw does not throw on $name and its result serializes', ({ value }) => {
    const out = scrubRaw(value, { maxLength: 10_000 });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('same input, same output, even after scrubbing other inputs in between', () => {
    const inputs = [
      `x ${sample('Anthropic', 1)} y`,
      `Authorization: Bearer ${highEntropyToken(5, 32)}`,
      'API_KEY=hunter2',
      `${sample('GitHub personal', 2)} and ${sample('Slack', 3)}`,
      'The quick brown fox.',
      highEntropyToken(6, 48),
    ];
    const first = inputs.map((input) => scrubText(input));
    const second = inputs.map((input) => scrubText(input));
    const reversed = [...inputs]
      .reverse()
      .map((input) => scrubText(input))
      .reverse();
    expect(second).toEqual(first);
    expect(reversed).toEqual(first);
    const raw = { list: inputs };
    expect(scrubRaw(raw, { maxLength: 10_000 })).toEqual(scrubRaw(raw, { maxLength: 10_000 }));
  });
});
