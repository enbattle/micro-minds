// Task 2.2-fix2: scrubber review findings left open after 2.2-fix. Clauses:
//   H1 a secret word followed by KEY is secret-named whatever word precedes KEY; structural keys
//      (`key`, `primaryKey`, `sortKey`, …) keep their values
//   H2 a secret word followed by ID, NAME, URL, PATH, ENDPOINT, FILE or PREFIX stays secret-named
//   H3 scrubRaw on a self-containing array under a secret-named key returns promptly
//   H4 in source-style assignments, only an all-lower-case dotted name (no digits, no capitals)
//      is exempt as code
//   H5 a secret KEY=value right after an opening quote runs to the matching closing quote
//   H6 label-joined hashes and search URLs are ordinary text; random single-case tokens are not
//
// Public surface under test (packages/shared/src/index.ts): REDACTION_MARKER, scrubText(text),
// scrubRaw(value, { maxLength }). Random tokens and hashes are generated at runtime from a seed.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, scrubRaw, scrubText } from './index.ts';
import { hexString, lowerToken, NAME_WORDS } from './scrub.fix.test-helpers.ts';
import { chars, HEX, prng } from './scrub.test-helpers.ts';

const M = REDACTION_MARKER;
const BIG = { maxLength: 1_000_000 };
const SEEDS = [1, 2, 3, 20_260_928] as const;
const FC_SEED = 20_260_928;

/** A short secret value no other rule would catch (no known prefix, far below 40 chars). */
const VALUE = 'hunter2x9Qz';

// -------------------------------------------------------------------------------------------
// H1: <word>_KEY is secret-named whatever the word; structural keys are not.
// -------------------------------------------------------------------------------------------

const VENDOR_KEYS = [
  'STRIPE_KEY',
  'OPENAI_KEY',
  'APP_KEY',
  'DB_KEY',
  'DEPLOY_KEY',
  'SESSION_KEY',
  'SENDGRID_KEY',
  'GOOGLE_MAPS_KEY',
  'MY_KEY',
  'KEY',
] as const;

describe('H1: a secret word followed by KEY is secret-named whatever word comes before it', () => {
  it.each(VENDOR_KEYS.map((key) => ({ name: key, key })))(
    'env line $name=value → value redacted, key kept',
    ({ key }) => {
      expect(scrubText(`${key}=${VALUE}`)).toBe(`${key}=${M}`);
    },
  );

  it.each(VENDOR_KEYS.map((key) => ({ name: key, key })))(
    'export line `export $name="value"` → value redacted, key kept',
    ({ key }) => {
      expect(scrubText(`export ${key}="${VALUE}"`)).toBe(`export ${key}="${M}"`);
    },
  );

  it.each(VENDOR_KEYS.map((key) => ({ name: key, key })))(
    'shell assignment `cd app && $name=value npm start` → only the value is redacted',
    ({ key }) => {
      expect(scrubText(`cd app && ${key}=${VALUE} npm start`)).toBe(
        `cd app && ${key}=${M} npm start`,
      );
    },
  );

  it.each([
    { name: 'stripeKey', key: 'stripeKey' },
    { name: 'appKey', key: 'appKey' },
    { name: 'deployKey', key: 'deployKey' },
    { name: 'OPENAI_KEY', key: 'OPENAI_KEY' },
    { name: 'stripe_key', key: 'stripe_key' },
  ])('scrubRaw masks the value under $name', ({ key }) => {
    const out = scrubRaw({ env: { [key]: VALUE }, n: 1 }, BIG);
    expect(out).toEqual({ env: { [key]: M }, n: 1 });
    expect(JSON.stringify(out)).not.toContain(VALUE);
  });
});

const STRUCTURAL_KEYS = [
  'key',
  'primaryKey',
  'sortKey',
  'keyPath',
  'foreign_key',
  'partitionKey',
  'cacheKey',
  'tokenType',
  'token_count',
  'max_tokens',
  'passThrough',
  'PASSWORD_MIN_LENGTH',
] as const;

const STRUCTURAL_VALUES: readonly unknown[] = ['user_id', 'session.id', 'hunter2', 12, 0, true];

describe('H1 guard: structural keys keep their values in scrubRaw', () => {
  it.each(STRUCTURAL_KEYS.map((key) => ({ name: key, key })))(
    '$name keeps its value',
    ({ key }) => {
      for (const value of STRUCTURAL_VALUES) {
        expect(scrubRaw({ [key]: value }, BIG)).toEqual({ [key]: value });
      }
    },
  );

  it('an OpenTelemetry attribute {key, value} keeps its key name', () => {
    const input = {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'claude-code' } },
          { key: 'session.id', value: { stringValue: 'abc-123' } },
          { key: 'tokens', value: { intValue: 42 } },
        ],
      },
    };
    expect(scrubRaw(input, BIG)).toEqual(input);
  });
});

// -------------------------------------------------------------------------------------------
// H2: a secret word followed by ID, NAME, URL, PATH, ENDPOINT, FILE or PREFIX stays secret.
// -------------------------------------------------------------------------------------------

function uuid(seed: number): string {
  const next = prng(seed);
  return [8, 4, 4, 4, 12].map((length) => chars(next, length, HEX)).join('-');
}

const H2_ROWS = [
  { name: 'VAULT_SECRET_ID (UUID)', key: 'VAULT_SECRET_ID', value: uuid(7) },
  { name: 'SECRET_ID', key: 'SECRET_ID', value: VALUE },
  { name: 'CLIENT_SECRET_ID', key: 'CLIENT_SECRET_ID', value: VALUE },
  { name: 'GITHUB_TOKEN_ID', key: 'GITHUB_TOKEN_ID', value: VALUE },
  { name: 'API_TOKEN_NAME', key: 'API_TOKEN_NAME', value: VALUE },
  {
    name: 'SENTRY_DSN_URL',
    key: 'SENTRY_DSN_URL',
    value: 'https://abc123def456@o1.ingest.sentry.io/1',
  },
  { name: 'ADMIN_PASSWORD_URL', key: 'ADMIN_PASSWORD_URL', value: VALUE },
  { name: 'MY_PASSWORD_PATH', key: 'MY_PASSWORD_PATH', value: VALUE },
] as const;

describe('H2: a secret word followed by a descriptor word is still secret-named', () => {
  it.each(H2_ROWS)('env line $name=value → value redacted, key kept', ({ key, value }) => {
    const out = scrubText(`${key}=${value}`);
    expect(out).toBe(`${key}=${M}`);
  });

  it.each(H2_ROWS)('shell assignment of $name → the value does not survive', ({ key, value }) => {
    const out = scrubText(`cd app && ${key}=${value} npm start`);
    expect(out).toBe(`cd app && ${key}=${M} npm start`);
  });

  it.each(H2_ROWS)('scrubRaw masks the value under $name', ({ key, value }) => {
    const out = scrubRaw({ env: { [key]: value } }, BIG);
    expect(out).toEqual({ env: { [key]: M } });
  });

  it('the Sentry DSN user part (abc123def456) does not survive in any form', () => {
    const value = 'https://abc123def456@o1.ingest.sentry.io/1';
    for (const input of [`SENTRY_DSN_URL=${value}`, `export SENTRY_DSN_URL="${value}"`]) {
      expect(scrubText(input)).not.toContain('abc123def456');
    }
  });
});

// -------------------------------------------------------------------------------------------
// H3: self-containing arrays under a secret-named key. Run in a worker thread so a scrubber
// that recurses exponentially fails this test instead of hanging the suite.
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
    const secret = workerData.secret;
    const build = {
      'token-once': () => { const a = [secret]; a.push(a); return { token: a }; },
      'token-twice': () => { const a = [secret]; a.push(a, a); return { token: a }; },
      'password-twice': () => { const a = [secret, 'x']; a.push(a, a); return { password: a }; },
      'password-thrice': () => { const a = [secret]; a.push(a, a, a); return { password: a }; },
      'nested-object-twice': () => {
        const a = [secret]; a.push(a, a);
        return { config: { db: { password: a } }, other: 'ok' };
      },
      'object-in-array-twice': () => {
        const a = [secret]; a.push({ inner: a }, a, a);
        return { auth: { token: a } };
      },
    }[workerData.name];
    const value = build();
    const start = performance.now();
    const out = scrubRaw(value, { maxLength: 1000000 });
    const ms = performance.now() - start;
    parentPort.postMessage({ status: 'done', json: JSON.stringify(out), ms });
  } catch (error) {
    parentPort.postMessage({ status: 'threw', error: String(error) });
  }
})();
`;

/** Wall-clock limit for the worker, including its start-up and module load. */
const WORKER_LIMIT_MS = 10_000;

function scrubCycleInWorker(name: string, secret: string): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { url: INDEX_URL, name, secret },
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

describe('H3: scrubRaw on a self-containing array under a secret key returns promptly', () => {
  it.each([
    { name: 'token: an array containing itself once', build: 'token-once' },
    { name: 'token: an array containing itself twice', build: 'token-twice' },
    { name: 'password: an array containing itself twice', build: 'password-twice' },
    { name: 'password: an array containing itself three times', build: 'password-thrice' },
    {
      name: 'nested object → password: array containing itself twice',
      build: 'nested-object-twice',
    },
    { name: 'token: array holding itself twice and via an object', build: 'object-in-array-twice' },
  ])(
    '$name → returns well under a second, serializes, and no secret survives',
    async ({ build }) => {
      const secret = `pw-${chars(prng(11), 20, HEX)}-cycle`;
      const result = await scrubCycleInWorker(build, secret);
      expect(result.status).toBe('done');
      if (result.status !== 'done') return;
      expect(typeof result.json).toBe('string');
      expect(String(result.json)).not.toContain(secret);
      expect(result.ms).toBeLessThan(1_000);
    },
    WORKER_LIMIT_MS + 10_000,
  );
});

// -------------------------------------------------------------------------------------------
// H4: dotted values in source-style assignments.
// -------------------------------------------------------------------------------------------

describe('H4: a dotted value is only code when every segment is lower-case letters, _ or $', () => {
  it.each([
    {
      name: 'indented DB_PASSWORD = word2.MixedCase',
      lead: '  DB_PASSWORD = ',
      value: 'hunter2.x9Kq7Zp',
    },
    {
      name: 'indented password = leet.leet (digits in segments)',
      lead: '    password = ',
      value: 's3cr3t_v4lue.pr0d',
    },
    {
      name: 'indented password = pk.<jwt-like header>.<mixed-case>',
      lead: '  password = ',
      value: 'pk.eyJhbGciOi.aB3dEfGhIjKlMnOpQrStUv',
    },
  ])('$name → redacted, no segment survives', ({ lead, value }) => {
    const out = scrubText(`${lead}${value}`);
    expect(out).toBe(`${lead}${M}`);
    for (const segment of value.split('.')) {
      expect(out).not.toContain(segment);
    }
  });

  it.each([
    { name: 'password = config.db_password', input: '    password = config.db_password' },
    { name: 'token = self.settings.token', input: '  token = self.settings.token' },
  ])('guard: $name stays unchanged', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

// -------------------------------------------------------------------------------------------
// H5: KEY=value right after an opening quote runs to the matching closing quote.
// -------------------------------------------------------------------------------------------

describe('H5: a quoted secret KEY=value is redacted up to the matching closing quote', () => {
  it.each([
    {
      name: 'comma and punctuation in the value',
      input: 'docker run -e "DB_PASSWORD=P@ss,w0rd!" img',
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
      parts: ['P@ss', 'w0rd'],
    },
    {
      name: 'spaces in the value',
      input: 'docker run -e "API_TOKEN=my very s3cret value" img',
      expected: `docker run -e "API_TOKEN=${M}" img`,
      parts: ['my very', 's3cret', 'value'],
    },
    {
      name: 'parentheses in the value',
      input: 'docker run -e "DB_PASSWORD=pa(ss)w0rd9" img',
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
      parts: ['pa(', 'ss)', 'w0rd9'],
    },
    {
      name: 'brackets in the value',
      input: 'docker run -e "SECRET_KEY=ab[cd]ef9x" img',
      expected: `docker run -e "SECRET_KEY=${M}" img`,
      parts: ['ab[', 'cd]', 'ef9x'],
    },
    {
      name: 'backslashes in the value',
      input: 'docker run -e "DB_PASSWORD=pa\\ss\\w0rd9" img',
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
      parts: ['pa\\', 'ss\\', 'w0rd9'],
    },
    {
      name: 'single quotes in a double-quoted value',
      input: `docker run -e "DB_PASSWORD=it's'pw0rd9" img`,
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
      parts: ["it's", 'pw0rd9'],
    },
    {
      name: 'single-quoted assignment with spaces and a comma',
      input: "docker run -e 'DB_PASSWORD=P@ss, w0rd!' img",
      expected: `docker run -e 'DB_PASSWORD=${M}' img`,
      parts: ['P@ss', 'w0rd'],
    },
    {
      name: 'quoted assignment inside a JSON array',
      input: '["DB_PASSWORD=P@ss,w0rd!", "NODE_ENV=production"]',
      expected: `["DB_PASSWORD=${M}", "NODE_ENV=production"]`,
      parts: ['P@ss', 'w0rd'],
    },
  ])('$name → context kept, no part of the value survives', ({ input, expected, parts }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    for (const part of parts) expect(out).not.toContain(part);
  });

  it.each([
    {
      name: 'value ends at the first closing quote on the line',
      input: 'echo "DB_PASSWORD=abc123" && echo "hi there"',
      expected: `echo "DB_PASSWORD=${M}" && echo "hi there"`,
    },
    {
      name: 'after ( the value ends at the comma',
      input: 'f(API_KEY=abc123,other)',
      expected: `f(API_KEY=${M},other)`,
    },
    {
      name: 'after [ the value ends at the bracket',
      input: 'args [API_KEY=abc123] done',
      expected: `args [API_KEY=${M}] done`,
    },
    {
      name: 'after , the value ends at the next comma',
      input: 'A=1,API_KEY=abc123,B=2',
      expected: `A=1,API_KEY=${M},B=2`,
    },
    {
      name: 'after : the value ends at the comma',
      input: 'env:API_KEY=abc123,next',
      expected: `env:API_KEY=${M},next`,
    },
    {
      name: 'after = the value ends at the parenthesis',
      input: 'set(opt=API_KEY=abc123) ok',
      expected: `set(opt=API_KEY=${M}) ok`,
    },
  ])('guard: $name', ({ input, expected }) => {
    expect(scrubText(input)).toBe(expected);
  });
});

// -------------------------------------------------------------------------------------------
// H6: ordinary text with long single-case runs stays; random single-case tokens do not.
// -------------------------------------------------------------------------------------------

describe('H6: search URLs and label-joined hashes are ordinary text', () => {
  const rows = SEEDS.flatMap((seed) => [
    {
      name: `worktree- + 40 hex #${seed}`,
      input: `worktree-${hexString(seed, 40)}`,
    },
    {
      name: `node-cache-linux-x64-npm- + 64 hex #${seed}`,
      input: `node-cache-linux-x64-npm-${hexString(seed, 64)}`,
    },
    {
      name: `python3.11-venv-cache- + 32 hex #${seed}`,
      input: `python3.11-venv-cache-${hexString(seed, 32)}`,
    },
    {
      name: `sha256- + 64 hex #${seed}`,
      input: `sha256-${hexString(seed, 64)}`,
    },
    {
      name: `cache key in a sentence #${seed}`,
      input: `Restored cache from key: node-cache-linux-x64-npm-${hexString(seed, 64)} (12 MB)`,
    },
  ]);

  it('a Google search URL stays unchanged', () => {
    const url = 'https://www.google.com/search?q=how+to+install+python3+on+windows+11+step';
    expect(scrubText(url)).toBe(url);
    expect(scrubText(`Open ${url} in a browser.`)).toBe(`Open ${url} in a browser.`);
  });

  it.each(rows)('$name stays unchanged', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });

  it('property: word labels joined to a hex hash by - or _ stay unchanged', () => {
    const labelArb = fc
      .record({
        words: fc.array(fc.constantFrom(...NAME_WORDS), { minLength: 1, maxLength: 4 }),
        digits: fc.option(fc.integer({ min: 0, max: 99 }), { nil: undefined }),
      })
      .map(({ words, digits }) => `${words.join('-')}${digits === undefined ? '' : digits}`);
    fc.assert(
      fc.property(
        labelArb,
        fc.constantFrom('-', '_'),
        fc.integer(),
        fc.constantFrom(32, 40, 64),
        (label, sep, seed, length) => {
          const input = `${label}${sep}${hexString(seed, length)}`;
          expect(scrubText(input)).toBe(input);
          const sentence = `Saved to ${input} in 3s.`;
          expect(scrubText(sentence)).toBe(sentence);
        },
      ),
      { seed: FC_SEED, numRuns: 300 },
    );
  });
});

describe('H6 guard: random single-case tokens without separators are still redacted', () => {
  const rows = SEEDS.flatMap((seed) =>
    [40, 52, 64].map((length) => ({
      name: `lower-case alphanumeric, ${length} chars #${seed}`,
      token: lowerToken(seed, length),
    })),
  );

  it.each(rows)('$name → the redaction marker, alone and in a sentence', ({ token }) => {
    expect(scrubText(token)).toBe(M);
    expect(scrubText(`seed is ${token} now`)).toBe(`seed is ${M} now`);
  });

  it('property: a 40–64 char lower-case alphanumeric token with digits is redacted', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 40, max: 64 }), (seed, length) => {
        const token = lowerToken(seed, length);
        expect(scrubText(token)).toBe(M);
      }),
      { seed: FC_SEED, numRuns: 200 },
    );
  });
});
