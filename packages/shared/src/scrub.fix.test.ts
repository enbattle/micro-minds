// Task 2.2-fix: review findings left open after 2.2's two review rounds. Clauses:
//   F1 single-case random tokens are redacted; single-case names, hashes and ids are not
//   F2 KEY=value right after a quote, =, (, [, comma, colon or a literal \n escape
//   F3 scrubRaw redacts string values under secret-named object keys
//   F4 source-code assignments of names and literals are not env content
//   F5 all of it stays linear-time on about 1 MB of adversarial input
//
// Public surface under test (packages/shared/src/index.ts): REDACTION_MARKER, scrubText(text),
// scrubRaw(value, { maxLength }). Every token is generated at runtime from a seed
// (scrub.test-helpers.ts, scrub.fix.test-helpers.ts), so the repo holds no token-shaped literal.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, scrubRaw, scrubText } from './index.ts';
import {
  base32Token,
  constantNameArb,
  hexString,
  kebabNameArb,
  lowerToken,
  snakeNameArb,
} from './scrub.fix.test-helpers.ts';
import {
  CROCKFORD,
  chars,
  KNOWN_SHAPES,
  ordinaryTextArb,
  prng,
  WRAPPERS,
} from './scrub.test-helpers.ts';

const M = REDACTION_MARKER;
const SEEDS = [1, 2, 3, 20_260_928] as const;
const BIG = { maxLength: 1_000_000 };

function sample(shapeName: string, seed = 7): string {
  const shape = KNOWN_SHAPES.find((candidate) => candidate.name.startsWith(shapeName));
  if (shape === undefined) throw new Error(`no shape ${shapeName}`);
  return shape.make(seed).secret;
}

function ulid(seed: number): string {
  const next = prng(seed);
  return `0${chars(next, 1, '1234567')}${chars(next, 24, CROCKFORD)}`;
}

// -------------------------------------------------------------------------------------------
// F1: single-case random tokens.
// -------------------------------------------------------------------------------------------

const SINGLE_CASE_TOKENS = [
  { name: 'lower-case alphanumeric token', make: lowerToken },
  { name: 'upper-case base32 token (A–Z, 2–7)', make: base32Token },
] as const;

describe('F1: long single-case random tokens are redacted like mixed-case ones', () => {
  const rows = SINGLE_CASE_TOKENS.flatMap(({ name, make }) =>
    [40, 52, 64].flatMap((length) =>
      SEEDS.map((seed) => ({
        name: `${name}, ${length} chars #${seed}`,
        token: make(seed, length),
      })),
    ),
  );

  it.each(rows)('$name on its own → the redaction marker', ({ token }) => {
    expect(scrubText(token)).toBe(M);
  });

  it.each(rows)('$name in a sentence → only the token is replaced', ({ token }) => {
    expect(scrubText(`The TOTP seed is ${token}, rotate it.`)).toBe(
      `The TOTP seed is ${M}, rotate it.`,
    );
  });

  it.each(SINGLE_CASE_TOKENS)(
    'property: a 40–64 char $name, alone and embedded in ordinary text, is redacted',
    ({ make }) => {
      fc.assert(
        fc.property(
          fc.record({
            seed: fc.integer(),
            length: fc.integer({ min: 40, max: 64 }),
            before: ordinaryTextArb,
            after: ordinaryTextArb,
            wrap: fc.constantFrom(...WRAPPERS),
            sepBefore: fc.constantFrom(' ', '\n'),
            sepAfter: fc.constantFrom(' ', '\n'),
          }),
          ({ seed, length, before, after, wrap, sepBefore, sepAfter }) => {
            const token = make(seed, length);
            expect(scrubText(token)).toBe(M);
            const head = `${before === '' ? '' : `${before}${sepBefore}`}${wrap[0]}`;
            const tail = `${wrap[1]}${after === '' ? '' : `${sepAfter}${after}`}`;
            const out = scrubText(`${head}${token}${tail}`);
            expect(out).not.toContain(token.slice(0, 16));
            expect(out).toBe(`${head}${M}${tail}`);
          },
        ),
        { numRuns: 200 },
      );
    },
  );

  it('property: single-case tokens in scrubRaw string values never survive', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 40, max: 64 }),
        fc.boolean(),
        (seed, length, lower) => {
          const token = lower ? lowerToken(seed, length) : base32Token(seed, length);
          const json = JSON.stringify(
            scrubRaw({ tool_response: { stdout: `otp seed ${token}\n` }, list: [token] }, BIG),
          );
          expect(json).not.toContain(token.slice(0, 16));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('F1: ordinary single-case text is left unchanged', () => {
  it.each([
    {
      name: 'kebab-case name from the clause',
      input: 'micro-minds-server-core-integration-tests-runner',
    },
    {
      name: 'constant name from the clause',
      input: 'MAXIMUM_CONCURRENT_AGENT_SESSIONS_PER_WORKSPACE',
    },
    {
      name: 'snake_case name',
      input: 'replay_fixture_events_through_reducer_and_snapshot_world_state',
    },
    {
      name: 'constant name in a sentence',
      input: 'Raised MAXIMUM_CONCURRENT_AGENT_SESSIONS_PER_WORKSPACE to 8.',
    },
    {
      name: 'kebab-case package in a command',
      input: 'npm run test -w @micro-minds/server-core-integration-tests-runner-helpers',
    },
    ...SEEDS.flatMap((seed) => [
      { name: `lower-case SHA-1 hash #${seed}`, input: hexString(seed, 40) },
      { name: `lower-case SHA-256 hash #${seed}`, input: hexString(seed, 64) },
      { name: `commit line with a SHA-1 #${seed}`, input: `commit ${hexString(seed, 40)}` },
      { name: `ULID #${seed}`, input: ulid(seed) },
    ]),
    { name: 'UUID', input: '550e8400-e29b-41d4-a716-446655440000' },
    { name: 'upper-case UUID', input: 'F47AC10B-58CC-4372-A567-0E02B2C3D479' },
  ])('$name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });

  const pieceArb = fc.oneof(
    kebabNameArb,
    snakeNameArb,
    constantNameArb,
    fc.integer().map((seed) => hexString(seed, 40)),
    fc.integer().map((seed) => hexString(seed, 64)),
    fc.integer().map(ulid),
    fc.uuid(),
    ordinaryTextArb,
  );

  it.each([
    { name: 'kebab-case names made of words', arb: kebabNameArb },
    { name: 'snake_case names made of words', arb: snakeNameArb },
    { name: 'upper-case constant names made of words', arb: constantNameArb },
  ])('property: long $name stay unchanged', ({ arb }) => {
    fc.assert(
      fc.property(arb, (name) => {
        expect(name.length).toBeGreaterThanOrEqual(40);
        expect(scrubText(name)).toBe(name);
      }),
      { numRuns: 300 },
    );
  });

  it('property: text mixing these with ordinary text stays unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(pieceArb, fc.constantFrom(' ', '\n', ', ', ' (', ') ')), {
          minLength: 1,
          maxLength: 12,
        }),
        (parts) => {
          const text = parts.map(([piece, sep]) => `${piece}${sep}`).join('');
          expect(scrubText(text)).toBe(text);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// -------------------------------------------------------------------------------------------
// F2: KEY=value right after a quote, =, (, [, comma, colon or a literal \n escape.
// -------------------------------------------------------------------------------------------

describe('F2: a secret KEY=value after a quote or punctuation is redacted, the rest kept', () => {
  const rows = [
    {
      name: 'docker -e with double quotes',
      input: 'docker run -e "DB_PASSWORD=hunter2" img',
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
    },
    {
      name: 'docker -e with single quotes',
      input: "docker run -e 'API_KEY=hunter2' img",
      expected: `docker run -e 'API_KEY=${M}' img`,
    },
    {
      name: '--env="…" flag',
      input: 'docker run --env="API_KEY=hunter2" img',
      expected: `docker run --env="API_KEY=${M}" img`,
    },
    {
      name: 'env with a quoted assignment',
      input: 'env "API_KEY=hunter2" ./run',
      expected: `env "API_KEY=${M}" ./run`,
    },
    {
      name: 'Windows cmd set with quotes',
      input: 'set "API_KEY=hunter2"',
      expected: `set "API_KEY=${M}"`,
    },
    {
      name: 'Windows cmd set with quotes, then a command',
      input: 'set "API_KEY=hunter2" && node server.js',
      expected: `set "API_KEY=${M}" && node server.js`,
    },
    {
      name: 'kubectl --from-literal (after =)',
      input: 'kubectl create secret generic s --from-literal=DB_PASSWORD=hunter2',
      expected: `kubectl create secret generic s --from-literal=DB_PASSWORD=${M}`,
    },
    {
      name: 'kubectl --from-literal followed by another flag',
      input: 'kubectl create secret generic s --from-literal=DB_PASSWORD=hunter2 --dry-run=client',
      expected: `kubectl create secret generic s --from-literal=DB_PASSWORD=${M} --dry-run=client`,
    },
    {
      name: 'JSON array of env strings',
      input: '["DB_PASSWORD=hunter2","NODE_ENV=production"]',
      expected: `["DB_PASSWORD=${M}","NODE_ENV=production"]`,
    },
    {
      name: 'JSON array, secret second (after a comma and a quote)',
      input: '["NODE_ENV=production","DB_PASSWORD=hunter2"]',
      expected: `["NODE_ENV=production","DB_PASSWORD=${M}"]`,
    },
    {
      name: 'in parentheses',
      input: '(DB_PASSWORD=hunter2)',
      expected: `(DB_PASSWORD=${M})`,
    },
    {
      name: 'in square brackets',
      input: '[API_KEY=hunter2]',
      expected: `[API_KEY=${M}]`,
    },
    {
      name: 'after a comma',
      input: 'gcloud run deploy app --set-env-vars=NODE_ENV=production,DB_PASSWORD=hunter2',
      expected: `gcloud run deploy app --set-env-vars=NODE_ENV=production,DB_PASSWORD=${M}`,
    },
    {
      name: 'after a colon',
      input: 'env:API_KEY=hunter2',
      expected: `env:API_KEY=${M}`,
    },
    {
      name: 'after a literal \\n escape, at the end',
      input: 'NODE_ENV=production\\nDB_PASSWORD=hunter2',
      expected: `NODE_ENV=production\\nDB_PASSWORD=${M}`,
    },
    {
      name: 'between literal \\n escapes (JSON-escaped .env content)',
      input: '{"stdout":"NODE_ENV=production\\nDB_PASSWORD=hunter2\\nPORT=3000\\n"}',
      expected: `{"stdout":"NODE_ENV=production\\nDB_PASSWORD=${M}\\nPORT=3000\\n"}`,
    },
  ];

  it.each(rows)('$name', ({ input, expected }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain('hunter2');
  });

  it('scrubRaw: a Bash command with a quoted secret assignment keeps the command', () => {
    expect(
      scrubRaw(
        { tool_name: 'Bash', tool_input: { command: 'docker run -e "DB_PASSWORD=hunter2" img' } },
        BIG,
      ),
    ).toEqual({
      tool_name: 'Bash',
      tool_input: { command: `docker run -e "DB_PASSWORD=${M}" img` },
    });
  });

  it.each([
    { name: 'docker -e with double quotes', input: 'docker run -e "NODE_ENV=production" img' },
    { name: 'docker -e with single quotes', input: "docker run -e 'LOG_LEVEL=debug' img" },
    { name: '--env="…" flag', input: 'docker run --env="NODE_ENV=production" img' },
    { name: 'env with a quoted assignment', input: 'env "NODE_ENV=production" ./run' },
    { name: 'Windows cmd set with quotes', input: 'set "PORT=3000"' },
    {
      name: 'kubectl --from-literal',
      input: 'kubectl create configmap c --from-literal=NODE_ENV=production',
    },
    { name: 'JSON array of env strings', input: '["NODE_ENV=production","PORT=3000"]' },
    { name: 'in parentheses', input: '(NODE_ENV=production)' },
    { name: 'in square brackets', input: '[NODE_ENV=production]' },
    { name: 'after a comma', input: '--set-env-vars=NODE_ENV=production,PORT=3000' },
    { name: 'after a colon', input: 'env:NODE_ENV=production' },
    { name: 'after a literal \\n escape', input: 'LOG_LEVEL=debug\\nNODE_ENV=production' },
    {
      name: 'TOKEN inside a word, quoted',
      input: 'docker run -e "TOKENIZERS_PARALLELISM=false" img',
    },
  ])('non-secret key stays unchanged: $name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

// -------------------------------------------------------------------------------------------
// F3: scrubRaw redacts string values under secret-named keys.
// -------------------------------------------------------------------------------------------

describe('F3: scrubRaw redacts a string value under a key that names a secret', () => {
  it.each([
    { name: 'API_KEY', key: 'API_KEY' },
    { name: 'DB_PASSWORD', key: 'DB_PASSWORD' },
    { name: 'password', key: 'password' },
    { name: 'PASSWORD', key: 'PASSWORD' },
    { name: 'Password', key: 'Password' },
    { name: 'apiKey (camelCase)', key: 'apiKey' },
    { name: 'api_key (snake_case)', key: 'api_key' },
    { name: 'api-key (kebab-case)', key: 'api-key' },
    { name: 'x-api-key (kebab-case header)', key: 'x-api-key' },
    { name: 'clientSecret (camelCase)', key: 'clientSecret' },
    { name: 'accessToken (camelCase)', key: 'accessToken' },
    { name: 'authToken (camelCase)', key: 'authToken' },
    { name: 'client_secret', key: 'client_secret' },
    { name: 'token', key: 'token' },
    { name: 'secret', key: 'secret' },
  ])('$name: a value with no secret shape → the marker', ({ key }) => {
    for (const value of ['hunter2', 'correct horse battery staple', 'dev']) {
      expect(scrubRaw({ [key]: value, note: value }, BIG)).toEqual({ [key]: M, note: value });
    }
  });

  it('secret keys nested in objects and arrays are redacted, their siblings kept', () => {
    const input = {
      hook_event_name: 'PostToolUse',
      tool_input: {
        env: { DB_PASSWORD: 'hunter2', NODE_ENV: 'production' },
        services: [
          { name: 'db', password: 'hunter3' },
          { name: 'api', apiKey: 'hunter4' },
        ],
      },
    };
    expect(scrubRaw(input, BIG)).toEqual({
      hook_event_name: 'PostToolUse',
      tool_input: {
        env: { DB_PASSWORD: M, NODE_ENV: 'production' },
        services: [
          { name: 'db', password: M },
          { name: 'api', apiKey: M },
        ],
      },
    });
  });

  it.each([
    { name: 'tokenizer', key: 'tokenizer' },
    { name: 'keyboard', key: 'keyboard' },
    { name: 'passenger', key: 'passenger' },
    { name: 'monkey', key: 'monkey' },
    { name: 'bypass', key: 'bypass' },
    { name: 'tokenizerModel (camelCase)', key: 'tokenizerModel' },
    { name: 'keyboardLayout (camelCase)', key: 'keyboardLayout' },
    { name: 'passenger_count (snake_case)', key: 'passenger_count' },
    { name: 'monkey-patch (kebab-case)', key: 'monkey-patch' },
    { name: 'bypassCache (camelCase)', key: 'bypassCache' },
    { name: 'TOKENIZERS_PARALLELISM', key: 'TOKENIZERS_PARALLELISM' },
    { name: 'KEYBOARD_LAYOUT', key: 'KEYBOARD_LAYOUT' },
  ])('a key with the word only inside another word keeps its value: $name', ({ key }) => {
    for (const value of ['hunter2', 'false', 'us']) {
      expect(scrubRaw({ [key]: value }, BIG)).toEqual({ [key]: value });
    }
  });

  it('non-string values under secret keys: numbers and booleans are treated alike', () => {
    const out = scrubRaw({ password: 1234, apiKey: true, token: null }, BIG);
    const json = JSON.stringify(out);
    expect(JSON.parse(json)).toEqual(out);
    const record = out as Record<string, unknown>;
    expect([1234, M]).toContain(record.password);
    expect([true, M]).toContain(record.apiKey);
    expect([null, M]).toContain(record.token);
    // Consistent: either both scalars are kept or both are redacted.
    expect(record.password === M).toBe(record.apiKey === M);
  });

  it('a nested object under a secret key: its strings are scrubbed as usual', () => {
    const ghp = sample('GitHub personal');
    const out = scrubRaw(
      {
        credentials: {
          username: 'dev',
          region: 'eu-west-1',
          note: `rotated ${ghp} yesterday`,
          apiKey: 'hunter2',
          retries: 3,
        },
      },
      BIG,
    );
    expect(out).toEqual({
      credentials: {
        username: 'dev',
        region: 'eu-west-1',
        note: `rotated ${M} yesterday`,
        apiKey: M,
        retries: 3,
      },
    });
  });

  it('property: any short value under a secret key never survives', () => {
    const keys = ['API_KEY', 'DB_PASSWORD', 'password', 'apiKey', 'api_key', 'clientSecret'];
    fc.assert(
      fc.property(
        fc.constantFrom(...keys),
        fc.stringMatching(/^[a-z0-9][a-z0-9 ]{5,29}$/),
        (key, value) => {
          expect(scrubRaw({ outer: { [key]: value } }, BIG)).toEqual({ outer: { [key]: M } });
        },
      ),
      { numRuns: 100 },
    );
  });
});

// -------------------------------------------------------------------------------------------
// F4: source-code assignments of names and literals are not env content.
// -------------------------------------------------------------------------------------------

describe('F4: code assignments of a name, dotted name or literal stay unchanged', () => {
  it.each([
    { name: 'dotted name, indented', input: '    key = item.name' },
    { name: 'Python None, indented', input: '    token = None' },
    { name: 'JS null', input: 'password = null' },
    { name: 'JS undefined', input: 'secret = undefined' },
    { name: 'Python True', input: 'api_key = True' },
    { name: 'dotted name', input: 'token = config.token' },
  ])('$name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });

  it('a block of Python with such assignments is unchanged', () => {
    const input = [
      'def lookup(items, config):',
      '    token = None',
      '    for item in items:',
      '        key = item.name',
      '        if key == "auth":',
      '            token = config.token',
      '    api_key = True',
      '    return token',
      '',
    ].join('\n');
    expect(scrubText(input)).toBe(input);
  });

  // Guards: env-style lines stay redacted. These pass today and must keep passing.
  it.each([
    {
      name: 'spaces around =, bare value',
      input: 'CLIENT_SECRET = hunter2',
      keep: 'CLIENT_SECRET =',
    },
    { name: 'no spaces', input: 'API_KEY=hunter2', keep: 'API_KEY=' },
    { name: 'a literal word with no spaces', input: 'PASSWORD=True', keep: 'PASSWORD=' },
    { name: 'quoted literal with spaces', input: 'API_KEY = "hunter2"', keep: 'API_KEY =' },
  ])('guard, still redacted: $name', ({ input, keep }) => {
    const out = scrubText(input);
    expect(out.startsWith(keep)).toBe(true);
    expect(out).toContain(M);
    expect(out.slice(keep.length)).not.toMatch(/hunter2|True/);
  });
});

// -------------------------------------------------------------------------------------------
// F5: time. Same method as scrub.revision.test.ts (R1): each flood doubles from 16 K to about
// 1 M characters and every step must finish within the bound.
// -------------------------------------------------------------------------------------------

const TIME_BOUND_MS = 1_000;
const SIZES = [16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576] as const;

function flood(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length));
}

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const TEXT_FLOODS: { name: string; unit: string }[] = [
  { name: "'\"DB_PASSWORD=' repeated", unit: '"DB_PASSWORD=' },
  { name: '\'"DB_PASSWORD=x"\' repeated', unit: '"DB_PASSWORD=x"' },
  { name: "literal '\\nAPI_KEY=' repeated", unit: '\\nAPI_KEY=' },
  { name: "literal '\\nAPI_KEY=x' repeated", unit: '\\nAPI_KEY=x' },
  { name: "'(DB_PASSWORD=' repeated", unit: '(DB_PASSWORD=' },
  { name: "'[API_KEY=' repeated", unit: '[API_KEY=' },
  { name: "',API_KEY=' repeated", unit: ',API_KEY=' },
  { name: "':API_KEY=' repeated", unit: ':API_KEY=' },
  { name: "'=API_KEY=' repeated", unit: '=API_KEY=' },
  { name: "'--from-literal=DB_PASSWORD=' repeated", unit: '--from-literal=DB_PASSWORD=' },
  { name: "'\\'API_KEY=' repeated", unit: "'API_KEY=" },
  { name: 'one long lower-case alphanumeric run', unit: 'ab3' },
  { name: 'one long upper-case base32 run', unit: 'AB3' },
  { name: 'one long lower-case hex run', unit: 'a1' },
  { name: 'one long kebab-case word run', unit: 'micro-minds-' },
  { name: 'one long constant-name word run', unit: 'MAX_AGENT_' },
  { name: "'token = config.' on one line", unit: 'token = config.' },
  { name: "'key = None ' on one line", unit: 'key = None ' },
  { name: "'    token = None' lines", unit: '    token = None\n' },
];

/** A payload of about `size` characters with secret-named keys everywhere. */
const RAW_FLOODS: { name: string; make: (size: number) => unknown }[] = [
  {
    name: 'a wide object of secret-named keys',
    make: (size) =>
      Object.fromEntries(
        Array.from({ length: Math.ceil(size / 24) }, (_, i) => [`DB_PASSWORD_${i}`, 'hunter2']),
      ),
  },
  {
    name: 'an array of objects with secret and look-alike keys',
    make: (size) =>
      Array.from({ length: Math.ceil(size / 60) }, () => ({
        apiKey: 'hunter2',
        tokenizer: 'bpe',
        clientSecret: 'x',
      })),
  },
  {
    name: 'a deep chain of secret-keyed objects with big strings',
    make: (size) => {
      let node: unknown = 'bottom';
      for (let depth = 0; depth < 50; depth++) {
        node = { accessToken: 'a'.repeat(Math.ceil(size / 50)), next: node };
      }
      return node;
    },
  },
  {
    name: 'one huge camelCase key',
    make: (size) => ({ [`${'apiKey'.repeat(Math.ceil(size / 6))}`]: 'hunter2' }),
  },
  {
    name: 'one huge snake_case key with no secret word',
    make: (size) => ({ [`${'monkey_'.repeat(Math.ceil(size / 7))}`]: 'value' }),
  },
];

describe('F5: the new forms scrub in linear time (about 1 MB)', () => {
  it.each(TEXT_FLOODS)(
    'scrubText: $name, doubling up to 1 MB, each step within the bound',
    ({ unit }) => {
      for (const size of SIZES) {
        const input = flood(unit, size);
        const ms = elapsed(() => scrubText(input));
        expect(ms, `${input.length} chars took ${Math.round(ms)} ms`).toBeLessThan(TIME_BOUND_MS);
      }
    },
    120_000,
  );

  it.each(RAW_FLOODS)(
    'scrubRaw: $name, doubling up to 1 MB, each step within the bound',
    ({ make }) => {
      for (const size of SIZES) {
        const value = make(size);
        let out: unknown;
        const ms = elapsed(() => {
          out = scrubRaw(value, { maxLength: 10_000 });
        });
        expect(ms, `${size} chars took ${Math.round(ms)} ms`).toBeLessThan(TIME_BOUND_MS);
        expect(JSON.stringify(out).length).toBeLessThanOrEqual(10_000);
      }
    },
    120_000,
  );
});
