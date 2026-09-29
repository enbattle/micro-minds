// Task 2.2, revision: behavior the first locked corpus (scrub.test.ts, scrub.property.test.ts)
// left open, found by the reviewer and the security pass. Points R1–R9 below follow the
// revision request:
//   R1 time bound on adversarial input        R6 shell forms of secrets in the middle of a line
//   R2 more known key shapes                  R7 high entropy without over-redaction
//   R3 passwords in URLs                      R8 scrubRaw object keys and own `__proto__` keys
//   R4 env keys matched by `_`-separated part R9 scrubRaw with a NaN, negative or infinite cap
//   R5 source code is not env content
//
// Public surface under test (packages/shared/src/index.ts): REDACTION_MARKER, scrubText(text),
// scrubRaw(value, { maxLength }). Every token is generated at runtime from a seed
// (scrub.test-helpers.ts), so the repo holds no token-shaped literal.
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, scrubRaw, scrubText } from './index.ts';
import {
  ALNUM,
  BASE64URL,
  chars,
  digitFreeToken,
  HEX,
  highEntropyToken,
  KNOWN_SHAPES,
  LETTERS,
  MORE_KNOWN_SHAPES,
  ordinaryTextArb,
  prng,
  WRAPPERS,
} from './scrub.test-helpers.ts';

const M = REDACTION_MARKER;
const SEEDS = [1, 2, 3, 20_260_928] as const;
const BIG = { maxLength: 1_000_000 };

/** A password-like value: mixed case, digits and URL-safe punctuation, from a seed. */
function password(seed: number): string {
  const next = prng(seed);
  return `${chars(next, 1, 'ABCDEFGH')}${chars(next, 1, 'stuvwxyz')}${chars(next, 1, '23456789')}${chars(next, 11, `${ALNUM}-._~!*`)}`;
}

function sample(shapeName: string, seed = 7): string {
  const shape = KNOWN_SHAPES.find((candidate) => candidate.name.startsWith(shapeName));
  if (shape === undefined) throw new Error(`no shape ${shapeName}`);
  return shape.make(seed).secret;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected a plain object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

// -------------------------------------------------------------------------------------------
// R1: time. Each flood grows by doubling from 16 K to about 1 M characters, and every step
// must finish within the bound. A quadratic scrubber fails at a small step within seconds
// instead of blocking the suite for minutes on the 1 MB input.
// -------------------------------------------------------------------------------------------

/**
 * Generous: today's linear passes over 1 MB take 20–60 ms on a dev laptop, while a pass that
 * rescans the rest of the input from every prefix takes seconds to minutes.
 */
const TIME_BOUND_MS = 1_000;
const TOP_SIZE = 1_048_576;
const SIZES = [16_384, 32_768, 65_536, 131_072, 262_144, 524_288, TOP_SIZE] as const;
const PEM_BEGIN = `${'-'.repeat(5)}BEGIN PRIVATE KEY${'-'.repeat(5)}`;
const PEM_BEGIN_RSA = `${'-'.repeat(5)}BEGIN RSA PRIVATE KEY${'-'.repeat(5)}`;

const FLOODS: { name: string; unit: string }[] = [
  { name: "'-eyJ' repeated (JWT starts glued by dashes)", unit: '-eyJ' },
  { name: "'eyJ' repeated with no separator", unit: 'eyJ' },
  { name: 'JWT header then a dot, repeated', unit: 'eyJhbGciOi.' },
  { name: 'JWT header and payload with no signature, repeated', unit: 'eyJhbGciOi.eyJzdWIiOi.' },
  { name: 'JWT starts separated by spaces', unit: 'eyJabcde.eyJabcde ' },
  { name: 'PEM BEGIN lines with no END', unit: `${PEM_BEGIN}\n` },
  {
    name: 'PEM BEGIN lines with CRLF and a body line, no END',
    unit: `${PEM_BEGIN_RSA}\r\nMIIE\r\n`,
  },
  { name: 'PEM BEGIN headers glued together', unit: PEM_BEGIN },
  { name: "'-----BEGIN ' repeated", unit: '-----BEGIN ' },
  { name: 'dashes and letters', unit: '-----A' },
  { name: "'sk-' repeated", unit: 'sk-' },
  { name: "'sk_live_' repeated", unit: 'sk_live_' },
  { name: "'ghp_' repeated", unit: 'ghp_' },
  { name: "'glpat-' repeated", unit: 'glpat-' },
  { name: "'xoxb-' repeated", unit: 'xoxb-' },
  { name: "'AKIA' repeated", unit: 'AKIA' },
  { name: "'Bearer a' repeated", unit: 'Bearer a' },
  { name: "'Authorization: Basic ' repeated", unit: 'Authorization: Basic ' },
  { name: "'Authorization: token ' repeated", unit: 'Authorization: token ' },
  { name: "'API_KEY=' on one line", unit: 'API_KEY=' },
  { name: "'API_KEY=x ' on one line", unit: 'API_KEY=x ' },
  { name: "'&& API_KEY=' on one line", unit: '&& API_KEY=' },
  { name: "'A_' repeated (a huge key with no '=')", unit: 'A_' },
  { name: "'export ' repeated", unit: 'export ' },
  { name: "'--password=' repeated", unit: '--password=' },
  { name: "'://' repeated", unit: '://' },
  { name: "'postgres://u:' repeated", unit: 'postgres://u:' },
  { name: "'a:b@' repeated", unit: 'a:b@' },
  { name: "'a://b:c' repeated with no '@'", unit: 'a://b:c' },
  { name: "'=' repeated", unit: '=' },
  { name: 'one long high-entropy-looking run', unit: 'aB3' },
  { name: 'one long path-like run', unit: 'aB3/' },
  { name: 'camelCase words with digits, glued', unit: 'handleOAuth2Callback' },
  { name: 'blank lines', unit: '\n' },
  { name: 'env lines with a secret key', unit: 'API_KEY=x\n' },
  {
    name: 'every prefix together',
    unit: `-eyJ.${PEM_BEGIN}sk-ghp_glpat-xoxb-Bearer API_KEY=--password=postgres://u:a@`,
  },
];

function flood(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length));
}

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('R1: scrubbing stays fast on adversarial input (about 1 MB)', () => {
  it.each(FLOODS)(
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

  it.each(FLOODS)(
    'scrubRaw: $name inside a payload, doubling up to 1 MB, each step within the bound',
    ({ unit }) => {
      for (const size of SIZES) {
        const value = {
          hook_event_name: 'PostToolUse',
          tool_response: { stdout: flood(unit, size) },
        };
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

// -------------------------------------------------------------------------------------------
// R2: more known key shapes.
// -------------------------------------------------------------------------------------------

describe('R2: more known key shapes are redacted', () => {
  const rows = MORE_KNOWN_SHAPES.flatMap((shape) =>
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

  it.each(rows)('$name as a secret env value → key kept, value gone', ({ secret, core }) => {
    const out = scrubText(`STRIPE_SECRET_KEY=${secret}\nPORT=3000`);
    expect(out).toBe(`STRIPE_SECRET_KEY=${M}\nPORT=3000`);
    expect(out).not.toContain(core);
  });

  it.each(MORE_KNOWN_SHAPES)(
    'property: $name embedded anywhere in ordinary text is replaced and nothing else changes',
    ({ make }) => {
      fc.assert(
        fc.property(
          fc.record({
            seed: fc.integer(),
            before: ordinaryTextArb,
            after: ordinaryTextArb,
            wrap: fc.constantFrom(...WRAPPERS),
            sepBefore: fc.constantFrom(' ', '\n'),
            sepAfter: fc.constantFrom(' ', '\n'),
          }),
          ({ seed, before, after, wrap, sepBefore, sepAfter }) => {
            const { secret, core } = make(seed);
            const head = `${before === '' ? '' : `${before}${sepBefore}`}${wrap[0]}`;
            const tail = `${wrap[1]}${after === '' ? '' : `${sepAfter}${after}`}`;
            const out = scrubText(`${head}${secret}${tail}`);
            expect(out).not.toContain(core);
            expect(out).toBe(`${head}${M}${tail}`);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it('property: none of these shapes survives scrubRaw in nested string values', () => {
    fc.assert(
      fc.property(fc.integer(), fc.nat({ max: MORE_KNOWN_SHAPES.length - 1 }), (seed, index) => {
        const shape = MORE_KNOWN_SHAPES[index];
        if (shape === undefined) throw new Error('index out of range');
        const { secret, core } = shape.make(seed);
        const json = JSON.stringify(
          scrubRaw({ tool_input: { command: `deploy --key ${secret}` }, list: [secret] }, BIG),
        );
        expect(json).not.toContain(core);
      }),
      { numRuns: 200 },
    );
  });
});

// -------------------------------------------------------------------------------------------
// R3: passwords in URLs.
// -------------------------------------------------------------------------------------------

describe('R3: the password in scheme://user:password@host is redacted, the rest kept', () => {
  const rows = SEEDS.flatMap((seed) => {
    const pw = password(seed);
    return [
      {
        name: `env line DATABASE_URL #${seed}`,
        input: `DATABASE_URL=postgres://admin:${pw}@db:5432/app`,
        expected: `DATABASE_URL=postgres://admin:${M}@db:5432/app`,
        pw,
      },
      {
        name: `quoted env line with a query #${seed}`,
        input: `export DATABASE_URL="postgresql://admin:${pw}@db.internal:5432/app?sslmode=require"`,
        expected: `export DATABASE_URL="postgresql://admin:${M}@db.internal:5432/app?sslmode=require"`,
        pw,
      },
      {
        name: `in prose, with a + in the scheme #${seed}`,
        input: `connecting to mongodb+srv://app_user:${pw}@cluster0.example.net/test?retryWrites=true now`,
        expected: `connecting to mongodb+srv://app_user:${M}@cluster0.example.net/test?retryWrites=true now`,
        pw,
      },
      {
        name: `in a git clone command #${seed}`,
        input: `git clone https://dev:${pw}@github.com/enbattle/micro-minds.git && cd micro-minds`,
        expected: `git clone https://dev:${M}@github.com/enbattle/micro-minds.git && cd micro-minds`,
        pw,
      },
      {
        name: `empty user name #${seed}`,
        input: `redis://:${pw}@localhost:6379/0`,
        expected: `redis://:${M}@localhost:6379/0`,
        pw,
      },
      {
        name: `in a JSON string value #${seed}`,
        input: `{"url":"amqp://guest:${pw}@rabbit:5672/vhost","retries":3}`,
        expected: `{"url":"amqp://guest:${M}@rabbit:5672/vhost","retries":3}`,
        pw,
      },
    ];
  });

  it.each([
    ...rows,
    {
      name: 'a low-entropy password',
      input: 'DATABASE_URL=postgres://admin:hunter2@db:5432/app',
      expected: `DATABASE_URL=postgres://admin:${M}@db:5432/app`,
      pw: 'hunter2',
    },
    {
      name: 'a percent-encoded password',
      input: 'mysql://root:p%40ss%3Aword@127.0.0.1:3306/app',
      expected: `mysql://root:${M}@127.0.0.1:3306/app`,
      pw: 'p%40ss%3Aword',
    },
  ])('$name', ({ input, expected, pw }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(pw);
  });

  it('scrubRaw redacts a URL password in a nested value', () => {
    const pw = password(99);
    expect(scrubRaw({ env: { DATABASE_URL: `postgres://admin:${pw}@db:5432/app` } }, BIG)).toEqual({
      env: { DATABASE_URL: `postgres://admin:${M}@db:5432/app` },
    });
  });

  // Guards: URLs with no password in them. These pass today and must keep passing.
  it.each([
    { name: 'a port, no user info', input: 'https://example.com:8080/path/to/page' },
    { name: 'a user name, no password', input: 'ssh://git@github.com/enbattle/micro-minds.git' },
    { name: 'scp-style git remote', input: 'git@github.com:enbattle/micro-minds.git' },
    { name: 'mailto link', input: 'mailto:dev@example.com' },
    { name: 'a URL with no user info', input: 'DATABASE_URL=postgres://localhost:5432/app' },
    { name: 'a time and an at-sign in prose', input: 'meet at 12:30@the office' },
  ])('guard, unchanged: $name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

// -------------------------------------------------------------------------------------------
// R4: env keys match a secret word as a whole `_`-separated part.
// -------------------------------------------------------------------------------------------

describe('R4: an env key naming a secret as one of its _-separated parts', () => {
  it.each([
    { name: 'PASS part', input: 'DB_PASS=hunter2', keep: 'DB_PASS=' },
    { name: 'PWD part', input: 'DB_PWD=hunter2', keep: 'DB_PWD=' },
    { name: 'bare PASS', input: 'PASS=hunter2', keep: 'PASS=' },
    { name: 'PASS with export', input: 'export MAIL_PASS=hunter2', keep: 'export MAIL_PASS=' },
    { name: 'lower-case pass part', input: 'smtp_pass=hunter2', keep: 'smtp_pass=' },
    { name: 'PWD with spaces and quotes', input: 'REDIS_PWD = "hunter2"', keep: 'REDIS_PWD =' },
    {
      name: 'DSN part',
      input: 'SENTRY_DSN=https://hunter2@o0.ingest.example.io/42',
      keep: 'SENTRY_DSN=',
    },
  ])('$name → value redacted, key kept', ({ input, keep }) => {
    const out = scrubText(input);
    expect(out.startsWith(keep)).toBe(true);
    expect(out).toContain(M);
    expect(out).not.toContain('hunter2');
  });

  it.each([
    { name: 'TOKEN inside TOKENIZERS', input: 'TOKENIZERS_PARALLELISM=false' },
    { name: 'KEY inside KEYBOARD', input: 'KEYBOARD_LAYOUT=us' },
    { name: 'KEY inside MONKEY', input: 'MONKEY=1' },
    { name: 'PASS inside PASSENGER', input: 'PASSENGER_COUNT=3' },
    { name: 'PASS inside BYPASS', input: 'BYPASS_CACHE=1' },
    { name: 'PWD inside OLDPWD', input: 'OLDPWD=/home/dev/projects' },
  ])('$name → unchanged', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });

  it('a mixed env file: only the secret parts are redacted', () => {
    const input = [
      'TOKENIZERS_PARALLELISM=false',
      'DB_PASS=hunter2',
      'KEYBOARD_LAYOUT=us',
      'DB_PWD=hunter3',
      'MONKEY=1',
      'SENTRY_DSN=https://hunter4@o0.ingest.example.io/42',
      'PASSENGER_COUNT=3',
      '',
    ].join('\n');
    const expected = [
      'TOKENIZERS_PARALLELISM=false',
      `DB_PASS=${M}`,
      'KEYBOARD_LAYOUT=us',
      `DB_PWD=${M}`,
      'MONKEY=1',
      `SENTRY_DSN=${M}`,
      'PASSENGER_COUNT=3',
      '',
    ].join('\n');
    expect(scrubText(input)).toBe(expected);
  });
});

// -------------------------------------------------------------------------------------------
// R5: source code is not env content.
// -------------------------------------------------------------------------------------------

describe('R5: an assignment whose value is a code expression is left unchanged', () => {
  it.each([
    { name: 'await call, indented, JS', input: '  token = await getToken(req);' },
    { name: 'Python os.environ lookup', input: 'API_KEY = os.environ["API_KEY"]' },
    { name: 'Python os.getenv call', input: 'API_KEY = os.getenv("API_KEY")' },
    { name: 'const declaration with a call', input: 'const secret = readSecret(path);' },
    { name: 'function call', input: 'password = hash(input)' },
    { name: 'method call with arguments', input: '    password = bcrypt.hashSync(input, 10);' },
    { name: 'call with keyword arguments', input: 'api_key = load_key(path=config_path)' },
    { name: 'subscript lookup', input: "token = request.headers['authorization']" },
    { name: 'input() prompt', input: 'PASSWORD = input("Password: ")' },
  ])('$name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });

  it('a block of Python with such assignments is unchanged', () => {
    const input = [
      'import os',
      '',
      'def connect():',
      '    api_key = os.environ.get("API_KEY")',
      '    token = get_token(api_key)',
      '    return Client(token=token)',
      '',
    ].join('\n');
    expect(scrubText(input)).toBe(input);
  });

  // Guards: a literal string value in code is still a secret. These pass today.
  it.each([
    { name: 'Python string literal', input: 'API_KEY = "hunter2"', keep: 'API_KEY =' },
    { name: 'single-quoted literal', input: "password = 'hunter2'", keep: 'password =' },
  ])('guard, still redacted: $name', ({ input, keep }) => {
    const out = scrubText(input);
    expect(out.startsWith(keep)).toBe(true);
    expect(out).toContain(M);
    expect(out).not.toContain('hunter2');
  });
});

// -------------------------------------------------------------------------------------------
// R6: shell forms of secrets in the middle of a line.
// -------------------------------------------------------------------------------------------

describe('R6: shell forms of secrets mid-line are redacted and the command is kept', () => {
  const basic = Buffer.from(`admin:${password(5)}`, 'utf8').toString('base64');
  const classic = chars(prng(6), 40, HEX);
  const rows = [
    {
      name: 'env assignment after &&',
      input: 'cd app && API_KEY=hunter2 npm start',
      expected: `cd app && API_KEY=${M} npm start`,
      secret: 'hunter2',
    },
    {
      name: 'two assignments after env',
      input: 'env DB_PASSWORD=hunter2 GITHUB_TOKEN=hunter3 ./deploy.sh',
      expected: `env DB_PASSWORD=${M} GITHUB_TOKEN=${M} ./deploy.sh`,
      secret: 'hunter',
    },
    {
      name: 'docker -e assignment',
      input: 'docker run -e API_KEY=hunter2 --rm app:latest',
      expected: `docker run -e API_KEY=${M} --rm app:latest`,
      secret: 'hunter2',
    },
    {
      name: '--password= flag mid-command',
      input: 'mysql --password=hunter2 -u root',
      expected: `mysql --password=${M} -u root`,
      secret: 'hunter2',
    },
    {
      name: '--password= flag at the end',
      input: 'mysql -u root --password=hunter2',
      expected: `mysql -u root --password=${M}`,
      secret: 'hunter2',
    },
    {
      name: 'Basic auth header in a curl command',
      input: `curl -H "Authorization: Basic ${basic}" https://api.example.com/v1/me`,
      expected: `curl -H "Authorization: Basic ${M}" https://api.example.com/v1/me`,
      secret: basic,
    },
    {
      name: 'token auth header in a curl command',
      input: `curl -H 'Authorization: token ${classic}' https://api.github.com/user`,
      expected: `curl -H 'Authorization: token ${M}' https://api.github.com/user`,
      secret: classic,
    },
    {
      name: 'Basic auth in a JSON headers object',
      input: `{"headers":{"Authorization":"Basic ${basic}","Accept":"application/json"}}`,
      expected: `{"headers":{"Authorization":"Basic ${M}","Accept":"application/json"}}`,
      secret: basic,
    },
    {
      name: 'token auth in a JSON headers object',
      input: `{"headers":{"authorization":"token ${classic}","accept":"application/json"}}`,
      expected: `{"headers":{"authorization":"token ${M}","accept":"application/json"}}`,
      secret: classic,
    },
  ];

  it.each(rows)('$name', ({ input, expected, secret }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(secret);
  });

  it('scrubRaw: a Bash tool_input.command with a mid-line secret keeps the command', () => {
    expect(
      scrubRaw(
        { tool_name: 'Bash', tool_input: { command: 'cd app && API_KEY=hunter2 npm start' } },
        BIG,
      ),
    ).toEqual({ tool_name: 'Bash', tool_input: { command: `cd app && API_KEY=${M} npm start` } });
  });

  // Guards: prose using the scheme words. These pass today.
  it.each([
    { name: 'Basic in prose', input: 'Basic usage: run the token command first.' },
    { name: 'token in prose', input: 'The token expired, so the session restarted.' },
    { name: 'a non-secret mid-line assignment', input: 'cd app && NODE_ENV=production npm start' },
  ])('guard, unchanged: $name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

// -------------------------------------------------------------------------------------------
// R7: high entropy without over-redaction.
// -------------------------------------------------------------------------------------------

describe('R7: identifiers and word paths stay, digit-free random tokens are redacted', () => {
  it.each([
    {
      name: 'camelCase identifier with digits',
      input: 'handleOAuth2CallbackForGitHubEnterpriseServer',
    },
    {
      name: 'identifier in a sentence',
      input: 'Renamed handleOAuth2CallbackForGitHubEnterpriseServer in auth.ts.',
    },
    {
      name: 'longer camelCase identifier with several digits',
      input: 'convertUtf8ToUtf16BeforeWritingToWin32ConsoleOutput',
    },
    {
      name: 'URL path with digits inside words',
      input: 'https://example.com/Docs/Release2Notes/Version3Details/Section4Overview/Part5',
    },
    {
      name: 'file path with digits inside words',
      input: 'packages/web/src/scene/Html5CanvasFallbackRenderer3dView/OAuth2LoginPanel.tsx',
    },
  ])('$name → unchanged', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });

  it.each([
    { name: 'letters only', alphabet: LETTERS },
    { name: 'base64 without digits (letters, + and /)', alphabet: `${LETTERS}+/` },
    { name: 'base64url without digits (letters, - and _)', alphabet: `${LETTERS}-_` },
  ])('property: a random 40–64 char token, $name, is redacted', ({ alphabet }) => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 40, max: 64 }), (seed, length) => {
        const token = digitFreeToken(seed, length, alphabet);
        expect(scrubText(token)).toBe(M);
        expect(scrubText(`session secret: ${token} (rotated)`)).toBe(
          `session secret: ${M} (rotated)`,
        );
      }),
      { seed: 20_260_928, numRuns: 200 },
    );
  });

  // Guard: tokens with digits are still redacted after the change. Passes today.
  it('guard: a random 40-char alphanumeric token with digits is still redacted', () => {
    for (const seed of SEEDS) expect(scrubText(highEntropyToken(seed, 40, ALNUM))).toBe(M);
    for (const seed of SEEDS) expect(scrubText(highEntropyToken(seed, 48, BASE64URL))).toBe(M);
  });
});

// -------------------------------------------------------------------------------------------
// R8: scrubRaw object keys.
// -------------------------------------------------------------------------------------------

describe('R8: scrubRaw scrubs object keys and keeps own __proto__ keys as data', () => {
  const ghp = sample('GitHub personal');
  const opaque = highEntropyToken(13, 32, BASE64URL);

  it('a secret used as an object key is scrubbed, its value kept', () => {
    const out = scrubRaw({ [ghp]: 'value', ok: 1 }, BIG);
    expect(out).toEqual({ [M]: 'value', ok: 1 });
    expect(JSON.stringify(out)).not.toContain(ghp);
  });

  it('a secret inside a nested key is scrubbed and the rest of the key kept', () => {
    const out = scrubRaw({ headers: { [`Authorization: Bearer ${opaque}`]: true } }, BIG);
    expect(out).toEqual({ headers: { [`Authorization: Bearer ${M}`]: true } });
  });

  it('an own __proto__ key from JSON.parse is kept as a data key and not inherited', () => {
    const source = '{"__proto__":{"polluted":"yes"},"k":"v"}';
    const input: unknown = JSON.parse(source);
    const out = asRecord(scrubRaw(input, BIG));
    expect(Object.keys(out)).toEqual(['__proto__', 'k']);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect('polluted' in out).toBe(false);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ polluted: 'yes' });
    expect(JSON.stringify(out)).toBe(source);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a nested own __proto__ key survives a JSON round trip', () => {
    const source = '{"a":{"__proto__":{"x":"1"},"y":2}}';
    const out = scrubRaw(JSON.parse(source), BIG);
    expect(JSON.stringify(out)).toBe(source);
    const a = asRecord(asRecord(out).a);
    expect('x' in a).toBe(false);
  });

  it('a secret inside an own __proto__ value is scrubbed and the key kept', () => {
    const input: unknown = JSON.parse(`{"__proto__":{"token":"${ghp}"},"k":"v"}`);
    const json = JSON.stringify(scrubRaw(input, BIG));
    expect(json).toBe(`{"__proto__":{"token":"${M}"},"k":"v"}`);
  });
});

// -------------------------------------------------------------------------------------------
// R9: scrubRaw with a NaN, negative or infinite cap. Run in a worker thread so a scrubber that
// loops forever fails this test instead of hanging the suite.
// -------------------------------------------------------------------------------------------

type WorkerResult =
  | { status: 'done'; json: unknown; ms: number }
  | { status: 'threw'; error: string }
  | { status: 'timeout' };

const INDEX_URL = pathToFileURL(path.join(import.meta.dirname, 'index.ts')).href;
const WORKER_SOURCE = `
(async () => {
  const { parentPort, workerData } = await import('node:worker_threads');
  try {
    const { scrubRaw } = await import(workerData.url);
    const value = { hook_event_name: 'PostToolUse', content: 'lorem ipsum dolor '.repeat(5000) };
    const start = performance.now();
    const out = scrubRaw(value, { maxLength: workerData.maxLength });
    const ms = performance.now() - start;
    parentPort.postMessage({ status: 'done', json: JSON.stringify(out), ms });
  } catch (error) {
    parentPort.postMessage({ status: 'threw', error: String(error) });
  }
})();
`;

/** Wall-clock limit for the worker, including its start-up and module load. */
const WORKER_LIMIT_MS = 10_000;

function scrubRawInWorker(maxLength: number): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { url: INDEX_URL, maxLength },
    });
    const timer = setTimeout(() => {
      resolve({ status: 'timeout' });
      void worker.terminate();
    }, WORKER_LIMIT_MS);
    worker.once('message', (message: WorkerResult) => {
      clearTimeout(timer);
      resolve(message);
      void worker.terminate();
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'threw', error: String(error) });
    });
  });
}

describe('R9: scrubRaw with an unusable maxLength returns promptly and serializes', () => {
  it.each([
    { name: 'NaN', maxLength: Number.NaN },
    { name: 'a negative number', maxLength: -1 },
    { name: 'a large negative number', maxLength: -1_000_000 },
    { name: 'Infinity', maxLength: Number.POSITIVE_INFINITY },
    { name: '-Infinity', maxLength: Number.NEGATIVE_INFINITY },
  ])(
    'maxLength $name → returns within the bound, does not throw, result serializes',
    async ({ maxLength }) => {
      const result = await scrubRawInWorker(maxLength);
      expect(result.status).toBe('done');
      if (result.status !== 'done') return;
      expect(typeof result.json).toBe('string');
      expect(result.ms).toBeLessThan(1_000);
    },
    WORKER_LIMIT_MS + 10_000,
  );
});
