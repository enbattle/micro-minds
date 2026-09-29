// Task 2.2-fix, revision: behavior the scrubber had before the 2.2-fix clauses (or that the task
// text of 2.2 requires) and that the locked tests don't pin. Clauses:
//   G1 a mid-line secret KEY=value after whitespace, ;, & or | is redacted in full, even when its
//      unquoted value holds , ( ) [ ] or a backslash
//   G2 the source-code exception is narrow: a dotted passphrase with capitals is still a secret
//   G3 scrubRaw masks numbers, booleans and array strings under a secret-named key
//   G4 structural keys (`key`, `primaryKey`, `token_count`, …) are not secret-named; the OTel
//      fixtures keep every attribute `key`
//   G5 long single-case names of short letter-and-digit parts joined by - or _ stay unchanged
//   G6 about 8 MB of token characters never makes a scrubber throw, and none of it survives
//
// Public surface under test (packages/shared/src/index.ts): REDACTION_MARKER, scrubText(text),
// scrubRaw(value, { maxLength }). Tokens are generated at runtime from a seed.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, scrubRaw, scrubText } from './index.ts';
import { BASE32, base32Token, LOWER_ALNUM, lowerToken } from './scrub.fix.test-helpers.ts';
import { ALNUM, chars, prng } from './scrub.test-helpers.ts';

const M = REDACTION_MARKER;
const BIG = { maxLength: 10_000_000 };

// -------------------------------------------------------------------------------------------
// G1: mid-line assignments keep their whole unquoted value together.
// -------------------------------------------------------------------------------------------

describe('G1: a mid-line secret KEY=value is redacted in full, punctuation in the value included', () => {
  const rows = [
    {
      name: 'after && : a value with a comma and !',
      input: 'cd app && DB_PASSWORD=P@ss,w0rd! npm start',
      expected: `cd app && DB_PASSWORD=${M} npm start`,
      leaks: ['P@ss', 'w0rd'],
    },
    {
      name: 'after a space, at the end: a value of comma-separated parts',
      input: 'FOO=1 DB_PASS=a,b,c,d',
      expected: `FOO=1 DB_PASS=${M}`,
      leaks: ['a,b', 'c,d'],
    },
    {
      name: 'after env: a value with a real backslash',
      input: 'env API_TOKEN=abc\\def1234 run',
      expected: `env API_TOKEN=${M} run`,
      leaks: ['abc', 'def1234'],
    },
    {
      name: 'after env: a value with a comma, then a command',
      input: 'env API_KEY=part1,part2rest npm start',
      expected: `env API_KEY=${M} npm start`,
      leaks: ['part1', 'part2rest'],
    },
    {
      name: 'after ; : a value with parentheses',
      input: 'cd app; DB_PASSWORD=pa(ss)w0rd npm start',
      expected: `cd app; DB_PASSWORD=${M} npm start`,
      leaks: ['pa(', 'ss)', 'w0rd'],
    },
    {
      name: 'after | : a value with square brackets',
      input: 'cat cfg | API_KEY=[abc]def1 node run.js',
      expected: `cat cfg | API_KEY=${M} node run.js`,
      leaks: ['abc', 'def1'],
    },
    {
      name: 'after a single & : a value with parentheses and a comma',
      input: 'sleep 1 & SECRET_KEY=a(b)c,d9 node app.js',
      expected: `sleep 1 & SECRET_KEY=${M} node app.js`,
      leaks: ['a(b', 'c,d9'],
    },
    {
      name: 'after a tab: a value with a comma, a bracket and a backslash',
      input: 'time\tDB_PASSWORD=x1,y2[z3]\\w4 npm test',
      expected: `time\tDB_PASSWORD=${M} npm test`,
      leaks: ['x1', 'y2', 'z3', 'w4'],
    },
  ];

  it.each(rows)('$name', ({ input, expected, leaks }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    for (const leak of leaks) expect(out).not.toContain(leak);
  });

  it('scrubRaw: a Bash command with such an assignment keeps the command around it', () => {
    expect(
      scrubRaw(
        {
          tool_name: 'Bash',
          tool_input: { command: 'cd app && DB_PASSWORD=P@ss,w0rd! npm start' },
        },
        BIG,
      ),
    ).toEqual({
      tool_name: 'Bash',
      tool_input: { command: `cd app && DB_PASSWORD=${M} npm start` },
    });
  });

  // Guards: the same punctuation in a non-secret assignment changes nothing.
  it.each([
    { name: 'comma list', input: 'cd app && NODE_OPTIONS=a,b,c npm start' },
    { name: 'parentheses', input: 'env LABEL=(dev) npm start' },
    { name: 'backslash', input: 'env OUT_DIR=build\\win run' },
  ])('guard, non-secret key unchanged: $name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

// -------------------------------------------------------------------------------------------
// G2: the source-code exception covers names and literals, not dotted passphrases.
// -------------------------------------------------------------------------------------------

describe('G2: a dotted passphrase with capitals in a spaced or indented assignment is redacted', () => {
  it.each([
    {
      name: 'spaces around =',
      input: 'password = Correct.Horse.Battery',
      expected: `password = ${M}`,
    },
    {
      name: 'indented constant name',
      input: '  DB_PASSWORD = Summer.Time',
      expected: `  DB_PASSWORD = ${M}`,
    },
    {
      name: 'indented, in an ini section (.pypirc)',
      input: '[pypi]\n  password = My.Pass.Word',
      expected: `[pypi]\n  password = ${M}`,
    },
    {
      name: 'tab-indented',
      input: '\tSECRET_KEY = Red.Apple.Pie',
      expected: `\tSECRET_KEY = ${M}`,
    },
  ])('$name', ({ input, expected }) => {
    expect(scrubText(input)).toBe(expected);
  });

  // Guards: the locked F4 code cases stay unchanged.
  it.each([
    { name: 'dotted name, indented', input: '    key = item.name' },
    { name: 'dotted name', input: 'token = config.token' },
    { name: 'Python None, indented', input: '    token = None' },
    { name: 'JS null', input: 'password = null' },
    { name: 'Python True', input: 'api_key = True' },
  ])('guard, code unchanged: $name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

// -------------------------------------------------------------------------------------------
// G3: scrubRaw masks every scalar under a secret-named key.
// -------------------------------------------------------------------------------------------

describe('G3: scrubRaw masks non-string values under a secret-named key', () => {
  it.each([
    { name: 'a number', input: { password: 12_345_678 }, expected: { password: M } },
    { name: 'a zero', input: { DB_PASSWORD: 0 }, expected: { DB_PASSWORD: M } },
    { name: 'true', input: { apiKey: true }, expected: { apiKey: M } },
    { name: 'false', input: { secret: false }, expected: { secret: M } },
    {
      name: 'strings in an array',
      input: { token: ['hunter2', 'x2'] },
      expected: { token: [M, M] },
    },
    {
      name: 'a number next to a non-secret number',
      input: { tool_input: { env: { DB_PORT: 5432, DB_PASSWORD: 5432 } } },
      expected: { tool_input: { env: { DB_PORT: 5432, DB_PASSWORD: M } } },
    },
  ])('$name → the marker', ({ input, expected }) => {
    expect(scrubRaw(input, BIG)).toEqual(expected);
  });

  it('a nested object under a secret key: its non-secret keys keep their values', () => {
    const input = { password: { hint: 'dev', length: 12, rotated: true } };
    expect(scrubRaw(input, BIG)).toEqual(input);
  });

  it('null under a secret key stays null or becomes the marker', () => {
    const out = scrubRaw({ token: null }, BIG) as Record<string, unknown>;
    expect([null, M]).toContain(out.token);
  });
});

// -------------------------------------------------------------------------------------------
// G4: structural keys are not secret-named.
// -------------------------------------------------------------------------------------------

const STRUCTURAL_VALUES: readonly unknown[] = ['session.id', 'bearer', 'hunter2', 12, 0, true];

describe('G4: structural keys keep their values in scrubRaw', () => {
  it.each([
    { name: 'bare key', key: 'key' },
    { name: 'primaryKey', key: 'primaryKey' },
    { name: 'sortKey', key: 'sortKey' },
    { name: 'keyPath', key: 'keyPath' },
    { name: 'foreign_key', key: 'foreign_key' },
    { name: 'tokenType', key: 'tokenType' },
    { name: 'token_count', key: 'token_count' },
    { name: 'max_tokens', key: 'max_tokens' },
    { name: 'passThrough', key: 'passThrough' },
    { name: 'PASSWORD_MIN_LENGTH', key: 'PASSWORD_MIN_LENGTH' },
  ])('$name keeps its value', ({ key }) => {
    for (const value of STRUCTURAL_VALUES) {
      expect(scrubRaw({ [key]: value }, BIG)).toEqual({ [key]: value });
    }
  });

  it('an OpenTelemetry attribute keeps its key name', () => {
    const input = {
      attributes: [
        { key: 'user.email', value: { stringValue: 'user@example.com' } },
        { key: 'session.id', value: { stringValue: '00000000-0000-4000-8000-000000000001' } },
        { key: 'terminal.type', value: { stringValue: 'vscode' } },
      ],
    };
    expect(scrubRaw(input, BIG)).toEqual(input);
  });

  it.each([
    'API_KEY',
    'apiKey',
    'SECRET_KEY',
    'secret_key',
    'private_key',
    'accessToken',
    'authToken',
    'GITHUB_TOKEN',
    'DB_PASSWORD',
    'SECRET_KEY_BASE',
  ])('guard, still secret-named: %s → the marker', (key) => {
    expect(scrubRaw({ [key]: 'hunter2', note: 'hunter2' }, BIG)).toEqual({
      [key]: M,
      note: 'hunter2',
    });
  });
});

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'claude');
const OTEL_FILES = readdirSync(FIXTURES)
  .filter((file) => /^otel-.*\.jsonl$/.test(file))
  .sort();

/** Every string `key` property of every object inside `value`, in walk order. */
function attributeKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) attributeKeys(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, item] of Object.entries(value)) {
      if (name === 'key' && typeof item === 'string') out.push(item);
      else attributeKeys(item, out);
    }
  }
  return out;
}

describe('G4: OpenTelemetry fixture replay keeps every attribute key', () => {
  it('has otel fixtures to replay', () => {
    expect(OTEL_FILES.length).toBeGreaterThanOrEqual(3);
  });

  it.each(OTEL_FILES)('%s: every line keeps every attribute key value', (file) => {
    const lines = readFileSync(path.join(FIXTURES, file), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const payload: unknown = JSON.parse(line);
      const keys = attributeKeys(payload);
      expect(keys.length).toBeGreaterThan(0);
      expect(attributeKeys(scrubRaw(payload, BIG))).toEqual(keys);
    }
  });
});

// -------------------------------------------------------------------------------------------
// G5: long single-case names with short letter-and-digit parts.
// -------------------------------------------------------------------------------------------

describe('G5: long single-case names of short letter-and-digit parts stay unchanged', () => {
  const names = [
    'k8s-deployment-manifest-for-production-cluster-eu-west-1',
    'python3-pip-install-requirements-ubuntu2204-docker',
    'MAX_RETRIES_FOR_S3_UPLOAD_V2_TIMEOUT_IN_SECONDS_DEFAULT',
    'test_should_handle_utf8_and_base64_encoded_payloads',
    'add-2fa-support-to-the-oauth2-callback-flow',
    // 39 characters, under the 40-character run length: a guard on its own.
    'strengths-and-weaknesses-review-2024-q3',
    // The same name past 40 characters, so the consonant run in "strengths" is exercised.
    'strengths-and-weaknesses-review-2024-q3-final',
  ];

  it.each(names)('%s alone', (name) => {
    expect(scrubText(name)).toBe(name);
  });

  it.each(names)('%s in a sentence', (name) => {
    const input = `Running ${name} now, see the log.`;
    expect(scrubText(input)).toBe(input);
  });

  it.each(names)('%s as a scrubRaw value', (name) => {
    expect(scrubRaw({ description: name }, BIG)).toEqual({ description: name });
  });

  // Guards: random single-case tokens with no separator stay redacted (the locked F1 tokens).
  it.each([
    { name: 'lower-case alphanumeric, 40', token: lowerToken(11, 40) },
    { name: 'lower-case alphanumeric, 64', token: lowerToken(12, 64) },
    { name: 'upper-case base32, 40', token: base32Token(13, 40) },
    { name: 'upper-case base32, 52', token: base32Token(14, 52) },
  ])('guard, still redacted: $name', ({ token }) => {
    expect(scrubText(token)).toBe(M);
  });
});

// -------------------------------------------------------------------------------------------
// G6: about 8 MB of token characters.
// -------------------------------------------------------------------------------------------

const HUGE = 8 * 1024 * 1024;

const RUNS = [
  { name: 'mixed-case letters and digits', alphabet: ALNUM, seed: 21 },
  { name: 'lower-case letters and digits', alphabet: LOWER_ALNUM, seed: 22 },
  { name: 'upper-case base32', alphabet: BASE32, seed: 23 },
] as const;

/** No 40-character window of `run` appears in `out`. */
function expectNoWindow(out: string, run: string): void {
  for (const match of out.matchAll(/[A-Za-z0-9]{40,}/g)) {
    expect(run.includes(match[0].slice(0, 40)), 'a 40-char window of the run survived').toBe(false);
  }
}

describe('G6: an 8 MB run of token characters never throws and never survives', () => {
  const rows = RUNS.flatMap(({ name, alphabet, seed }) => {
    const make = (): string => chars(prng(seed), HUGE, alphabet);
    return [
      {
        name: `scrubText, ${name}, alone`,
        run: (value: string): string => scrubText(value),
        make,
      },
      {
        name: `scrubText, ${name}, inside a sentence`,
        run: (value: string): string => scrubText(`stdout: ${value} (end)`),
        make,
      },
      {
        name: `scrubRaw, ${name}, as the whole value`,
        run: (value: string): string => JSON.stringify(scrubRaw(value, { maxLength: 20_000_000 })),
        make,
      },
      {
        name: `scrubRaw, ${name}, inside a hook payload`,
        run: (value: string): string =>
          JSON.stringify(
            scrubRaw(
              { tool_name: 'Bash', tool_response: { stdout: value } },
              { maxLength: 20_000_000 },
            ),
          ),
        make,
      },
    ];
  });

  it.each(rows)(
    '$name',
    ({ run, make }) => {
      const value = make();
      expect(value.length).toBe(HUGE);
      let out = '';
      expect(() => {
        out = run(value);
      }).not.toThrow();
      expectNoWindow(out, value);
    },
    120_000,
  );
});
