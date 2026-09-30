// The scrubber's time and size limits (task 2.2 and its review rounds): every pass stays linear on
// adversarial input, huge input never makes a scrubber throw and never leaks, and odd caps and
// self-containing values return promptly. The example corpus is in scrub.test.ts.
//
// Surface under test (packages/shared/src/index.ts): scrubText(text), scrubRaw(value, { maxLength }).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { scrubRaw, scrubText } from './index.ts';
import { ALNUM, BASE32, chars, HEX, LOWER_ALNUM, prng } from './scrub.test-helpers.ts';

// -------------------------------------------------------------------------------------------
// Linear time. Each flood grows by doubling from 16 K to about 1 M characters, and every step
// must finish within the bound. A quadratic scrubber fails at a small step within seconds
// instead of blocking the suite for minutes on the 1 MB input.
// -------------------------------------------------------------------------------------------

/**
 * Generous: today's linear passes over 1 MB take 20–60 ms on a dev laptop, while a pass that
 * rescans the rest of the input from every prefix takes seconds to minutes.
 */
const TIME_BOUND_MS = 1_000;
const SIZES = [16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576] as const;
const PEM_BEGIN = `${'-'.repeat(5)}BEGIN PRIVATE KEY${'-'.repeat(5)}`;
const PEM_BEGIN_RSA = `${'-'.repeat(5)}BEGIN RSA PRIVATE KEY${'-'.repeat(5)}`;

const FLOODS: readonly { name: string; unit: string }[] = [
  // Known-shape prefixes.
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
  // Headers, flags and URLs.
  { name: "'Bearer a' repeated", unit: 'Bearer a' },
  { name: "'Authorization: Basic ' repeated", unit: 'Authorization: Basic ' },
  { name: "'Authorization: token ' repeated", unit: 'Authorization: token ' },
  { name: "'--password=' repeated", unit: '--password=' },
  { name: "'://' repeated", unit: '://' },
  { name: "'postgres://u:' repeated", unit: 'postgres://u:' },
  { name: "'a:b@' repeated", unit: 'a:b@' },
  { name: "'a://b:c' repeated with no '@'", unit: 'a://b:c' },
  // KEY=value lines and assignments.
  { name: "'API_KEY=' on one line", unit: 'API_KEY=' },
  { name: "'API_KEY=x ' on one line", unit: 'API_KEY=x ' },
  { name: "'&& API_KEY=' on one line", unit: '&& API_KEY=' },
  { name: "'A_' repeated (a huge key with no '=')", unit: 'A_' },
  { name: "'export ' repeated", unit: 'export ' },
  { name: "'=' repeated", unit: '=' },
  { name: 'env lines with a secret key', unit: 'API_KEY=x\n' },
  { name: 'blank lines', unit: '\n' },
  { name: "'\"DB_PASSWORD=' repeated", unit: '"DB_PASSWORD=' },
  { name: '\'"DB_PASSWORD=x"\' repeated', unit: '"DB_PASSWORD=x"' },
  { name: "'\\'API_KEY=' repeated", unit: "'API_KEY=" },
  { name: "literal '\\nAPI_KEY=' repeated", unit: '\\nAPI_KEY=' },
  { name: "literal '\\nAPI_KEY=x' repeated", unit: '\\nAPI_KEY=x' },
  { name: "'(DB_PASSWORD=' repeated", unit: '(DB_PASSWORD=' },
  { name: "'[API_KEY=' repeated", unit: '[API_KEY=' },
  { name: "',API_KEY=' repeated", unit: ',API_KEY=' },
  { name: "':API_KEY=' repeated", unit: ':API_KEY=' },
  { name: "'=API_KEY=' repeated", unit: '=API_KEY=' },
  { name: "'--from-literal=DB_PASSWORD=' repeated", unit: '--from-literal=DB_PASSWORD=' },
  // Source-code assignments.
  { name: "'token = config.' on one line", unit: 'token = config.' },
  { name: "'key = None ' on one line", unit: 'key = None ' },
  { name: "'    token = None' lines", unit: '    token = None\n' },
  // Long runs.
  { name: 'one long high-entropy-looking run', unit: 'aB3' },
  { name: 'one long path-like run', unit: 'aB3/' },
  { name: 'camelCase words with digits, glued', unit: 'handleOAuth2Callback' },
  { name: 'one long lower-case alphanumeric run', unit: 'ab3' },
  { name: 'one long upper-case base32 run', unit: 'AB3' },
  { name: 'one long lower-case hex run', unit: 'a1' },
  { name: 'one long kebab-case word run', unit: 'micro-minds-' },
  { name: 'one long constant-name word run', unit: 'MAX_AGENT_' },
  {
    name: 'every prefix together',
    unit: `-eyJ.${PEM_BEGIN}sk-ghp_glpat-xoxb-Bearer API_KEY=--password=postgres://u:a@`,
  },
];

/** A payload of about `size` characters with secret-named keys everywhere. */
const RAW_FLOODS: readonly { name: string; make: (size: number) => unknown }[] = [
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

function flood(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length));
}

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('scrubbing stays linear on adversarial input (about 1 MB)', () => {
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

// -------------------------------------------------------------------------------------------
// Huge input: never throws, and no secret survives (the scrubber fails closed).
// -------------------------------------------------------------------------------------------

describe('huge adversarial strings never make a scrubber throw', () => {
  it.each([
    { name: '1 MB of one letter', value: 'a'.repeat(1_000_000) },
    { name: '200 000 dashes (PEM-like)', value: '-'.repeat(200_000) },
    { name: 'a repeated JWT prefix', value: 'eyJ.'.repeat(100_000) },
    { name: 'a repeated env prefix', value: 'API_KEY='.repeat(50_000) },
    { name: 'a repeated bearer prefix', value: 'Bearer '.repeat(50_000) },
  ])('$name: scrubText does not throw; scrubRaw does not throw and serializes', ({ value }) => {
    expect(() => scrubText(value)).not.toThrow();
    const out = scrubRaw(value, { maxLength: 10_000 });
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

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

describe('an 8 MB run of token characters never throws and never survives', () => {
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

// -------------------------------------------------------------------------------------------
// Values that could loop or recurse without end: an unusable cap, arrays that hold themselves.
// Each runs in a worker thread, so a scrubber that never returns fails the test instead of
// hanging the suite.
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
      'lorem': () => ({ hook_event_name: 'PostToolUse', content: 'lorem ipsum dolor '.repeat(5000) }),
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
    }[workerData.build];
    const value = build();
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

function scrubRawInWorker(build: string, maxLength: number, secret: string): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { url: INDEX_URL, build, maxLength, secret },
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

describe('scrubRaw returns promptly on values that could loop or recurse', () => {
  const secret = `pw-${chars(prng(11), 20, HEX)}-cycle`;

  it.each([
    { name: 'maxLength NaN', build: 'lorem', maxLength: Number.NaN },
    { name: 'maxLength a negative number', build: 'lorem', maxLength: -1 },
    { name: 'maxLength a large negative number', build: 'lorem', maxLength: -1_000_000 },
    { name: 'maxLength Infinity', build: 'lorem', maxLength: Number.POSITIVE_INFINITY },
    { name: 'maxLength -Infinity', build: 'lorem', maxLength: Number.NEGATIVE_INFINITY },
    { name: 'token: an array containing itself once', build: 'token-once', maxLength: 1_000_000 },
    {
      name: 'token: an array containing itself twice',
      build: 'token-twice',
      maxLength: 1_000_000,
    },
    {
      name: 'password: an array containing itself twice',
      build: 'password-twice',
      maxLength: 1_000_000,
    },
    {
      name: 'password: an array containing itself three times',
      build: 'password-thrice',
      maxLength: 1_000_000,
    },
    {
      name: 'nested object → password: an array containing itself twice',
      build: 'nested-object-twice',
      maxLength: 1_000_000,
    },
    {
      name: 'token: an array holding itself twice and via an object',
      build: 'object-in-array-twice',
      maxLength: 1_000_000,
    },
  ])(
    '$name → returns well under a second, does not throw, serializes, no secret survives',
    async ({ build, maxLength }) => {
      const result = await scrubRawInWorker(build, maxLength, secret);
      expect(result.status).toBe('done');
      if (result.status !== 'done') return;
      expect(typeof result.json).toBe('string');
      expect(String(result.json)).not.toContain(secret);
      expect(result.ms).toBeLessThan(1_000);
    },
    WORKER_LIMIT_MS + 10_000,
  );
});
