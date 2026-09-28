// Shared generators for the scrubber tests (task 2.2). Test-only: this file may use node: modules;
// the package source may not (packages/shared/CLAUDE.md).
//
// Every secret is built at runtime from a seeded PRNG. That keeps token-shaped literals out of the
// repo (secret scanners and push protection) and makes each sample random-looking, the way real
// keys are, instead of fast-check's small, repetitive strings.
import { Buffer } from 'node:buffer';
import fc from 'fast-check';

export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const DIGITS = '0123456789';
export const ALNUM = `${UPPER}${LOWER}${DIGITS}`;
export const BASE64URL = `${ALNUM}-_`;
export const BASE64 = `${ALNUM}+/`;
export const HEX = '0123456789abcdef';
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** mulberry32: a tiny deterministic PRNG, so a fast-check seed maps to one random-looking token. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function chars(next: () => number, length: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet.charAt(Math.floor(next() * alphabet.length));
  return out;
}

function between(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1));
}

function pick<T>(next: () => number, items: readonly [T, ...T[]]): T {
  return items[Math.floor(next() * items.length)] ?? items[0];
}

/** A long token with upper case, lower case and digits mixed, matching no known prefix. */
export function highEntropyToken(seed: number, length = 40, alphabet = ALNUM): string {
  const next = prng(seed);
  return (
    chars(next, 1, UPPER) +
    chars(next, 1, DIGITS) +
    chars(next, 1, LOWER) +
    chars(next, length - 3, alphabet)
  );
}

export interface SecretSample {
  /** The full secret as it appears in text. */
  secret: string;
  /** A random part of the secret (≥ 16 chars) that must not survive either. */
  core: string;
}

export interface SecretShape {
  name: string;
  make: (seed: number) => SecretSample;
}

function prefixed(
  prefix: string,
  length: number,
  alphabet: string,
): (seed: number) => SecretSample {
  return (seed) => {
    const core = chars(prng(seed), length, alphabet);
    return { secret: `${prefix}${core}`, core };
  };
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function jwt(seed: number): SecretSample {
  const next = prng(seed);
  const header = base64url(
    JSON.stringify({ alg: pick(next, ['HS256', 'RS256', 'ES256']), typ: 'JWT' }),
  );
  const payload = base64url(
    JSON.stringify({
      sub: chars(next, between(next, 6, 12), DIGITS),
      name: chars(next, between(next, 4, 10), LOWER),
      iat: between(next, 1_600_000_000, 1_900_000_000),
    }),
  );
  const signature = chars(next, 43, BASE64URL);
  return { secret: `${header}.${payload}.${signature}`, core: signature };
}

const DASHES = '-----';

function pem(label: string, eol: string): (seed: number) => SecretSample {
  return (seed) => {
    const next = prng(seed);
    const lines: string[] = [];
    const full = between(next, 2, 8);
    for (let i = 0; i < full; i++) lines.push(chars(next, 64, BASE64));
    lines.push(`${chars(next, between(next, 8, 60), BASE64)}==`);
    const core = lines[0] ?? '';
    const secret = [
      `${DASHES}BEGIN ${label}${DASHES}`,
      ...lines,
      `${DASHES}END ${label}${DASHES}`,
    ].join(eol);
    return { secret, core };
  };
}

function slack(seed: number): SecretSample {
  const next = prng(seed);
  const kind = pick(next, ['b', 'p', 'a', 'r', 's']);
  const core = chars(next, 24, ALNUM);
  const secret = `xox${kind}-${chars(next, between(next, 10, 13), DIGITS)}-${chars(next, between(next, 10, 13), DIGITS)}-${core}`;
  return { secret, core };
}

function githubPat(seed: number): SecretSample {
  const next = prng(seed);
  const core = `${chars(next, 22, ALNUM)}_${chars(next, 59, ALNUM)}`;
  return { secret: `github_pat_${core}`, core };
}

function anthropic(seed: number): SecretSample {
  const next = prng(seed);
  const core = chars(next, 93, BASE64URL);
  return { secret: `sk-ant-api03-${core}AA`, core };
}

/** The known secret shapes of clause 1, plus the high-entropy case of clause 4. */
export const KNOWN_SHAPES: readonly SecretShape[] = [
  { name: 'Anthropic API key (sk-ant-api03-…)', make: anthropic },
  { name: 'OpenAI key (sk-… legacy)', make: prefixed('sk-', 48, ALNUM) },
  { name: 'OpenAI project key (sk-proj-…)', make: prefixed('sk-proj-', 156, BASE64URL) },
  { name: 'GitHub personal token (ghp_)', make: prefixed('ghp_', 36, ALNUM) },
  { name: 'GitHub OAuth token (gho_)', make: prefixed('gho_', 36, ALNUM) },
  { name: 'GitHub user-to-server token (ghu_)', make: prefixed('ghu_', 36, ALNUM) },
  { name: 'GitHub server-to-server token (ghs_)', make: prefixed('ghs_', 36, ALNUM) },
  { name: 'GitHub refresh token (ghr_)', make: prefixed('ghr_', 36, ALNUM) },
  { name: 'GitHub fine-grained token (github_pat_)', make: githubPat },
  { name: 'AWS access key id (AKIA…)', make: prefixed('AKIA', 16, `${UPPER}${DIGITS}`) },
  { name: 'Google API key (AIza…)', make: prefixed('AIza', 35, BASE64URL) },
  { name: 'Slack token (xox…-)', make: slack },
  { name: 'JWT', make: jwt },
  { name: 'PEM RSA private key', make: pem('RSA PRIVATE KEY', '\n') },
  { name: 'PEM PKCS#8 private key', make: pem('PRIVATE KEY', '\n') },
  { name: 'PEM EC private key', make: pem('EC PRIVATE KEY', '\n') },
  { name: 'PEM OpenSSH private key', make: pem('OPENSSH PRIVATE KEY', '\n') },
  { name: 'PEM private key with CRLF line endings', make: pem('PRIVATE KEY', '\r\n') },
];

export const HIGH_ENTROPY_SHAPE: SecretShape = {
  name: 'high-entropy token (no known prefix)',
  make: (seed) => {
    const length = 40 + (Math.abs(seed) % 25);
    const secret = highEntropyToken(seed, length);
    return { secret, core: secret };
  },
};

// ---------------------------------------------------------------------------------------------
// Ordinary text: the negative shapes of clause 6.
// ---------------------------------------------------------------------------------------------

const WORDS = [
  'the',
  'agent',
  'is',
  'reading',
  'a',
  'file',
  'and',
  'then',
  'runs',
  'tests',
  'build',
  'passed',
  'failed',
  'retrying',
  'in',
  'worktree',
  'session',
  'started',
  'finished',
  'with',
  'exit',
  'code',
  'refactor',
  'reducer',
  'health',
  'mood',
  'idle',
  'working',
  'Hello',
  'World',
  'TypeScript',
  'README',
  'npm',
  'run',
  'check',
  'git',
  'commit',
  'push',
  'key',
  'token',
  'secret',
  'password',
  'rotation',
  'API',
  'docs',
  'fix:',
  'feat(shared):',
  '(42/42)',
  'OK',
  'ERROR',
  'warn',
  '->',
  '{',
  '}',
  '[]',
  '();',
  'const',
  'return',
  'await',
  'import',
  'from',
  'naïve',
  'café',
  'Zürich',
  '日本語',
  '—',
  '…',
  '✓',
] as const;

const PATH_SEGMENTS = [
  'Users',
  'dev',
  'projects',
  'micro-minds',
  'packages',
  'shared',
  'src',
  'apps',
  'server',
  'providers',
  'claude',
  'node_modules',
  '.bin',
  'dist',
  'fixtures',
  'docs',
  'protocols',
  'web',
  'components',
  'Program Files',
  'AppData',
  'Local',
  'Temp',
  'lib',
  'usr',
  'home',
  'etc',
] as const;

const FILE_NAMES = [
  'index.ts',
  'reduce.test.ts',
  'adapter.ts',
  'package.json',
  'README.md',
  'vitest.cmd',
  'npm-cli.js',
  'claude.md',
  'events.jsonl',
  'app.log',
  'tsconfig.json',
  'Board.tsx',
] as const;

const HOSTS = [
  'github.com',
  'docs.anthropic.com',
  'www.npmjs.com',
  'example.com',
  '127.0.0.1:4317',
  'localhost:5173',
  'registry.npmjs.org',
  'developer.mozilla.org',
] as const;

/** Source lines that must stay as they are. */
export const SOURCE_LINES = [
  'const token = await getToken(request.headers.authorization);',
  'const apiKey = config.apiKey;',
  'export const PASSWORD_MIN_LENGTH = 12;',
  "if (process.env.NODE_ENV === 'production') {",
  "import { createWorld, reduce } from './reduce.ts';",
  'export function normalizeClaudeHookPayloadToAgentEvent(payload: unknown): AgentEvent {',
  'for (let i = 0; i < items.length; i++) total += items[i].price * 1.2;',
  'SELECT id, created_at FROM sessions WHERE agent_id = ? ORDER BY ts DESC LIMIT 50;',
  'def compute_hash(data: bytes) -> str:',
  '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"}}',
] as const;

/** Non-secret `KEY=value` lines (clause 6). */
export const PLAIN_ENV_LINES = [
  'NODE_ENV=production',
  'PORT=3000',
  'HOST=127.0.0.1',
  'LOG_LEVEL=debug',
  'export PATH=/usr/local/bin:$PATH',
  'DEBUG=micro-minds:*',
  'TZ=UTC',
  'CI=true',
] as const;

const wordArb = fc.constantFrom(...WORDS);

const hexArb = (length: number): fc.Arbitrary<string> =>
  fc.integer().map((seed) => chars(prng(seed), length, HEX));

/** ULIDs look random: 10 time chars then 16 random Crockford base32 chars. */
export const ulidArb: fc.Arbitrary<string> = fc.integer().map((seed) => {
  const next = prng(seed);
  return `0${chars(next, 1, '1234567')}${chars(next, 8, CROCKFORD)}${chars(next, 16, CROCKFORD)}`;
});

const uuidArb = fc.oneof(
  fc.uuid(),
  fc.uuid().map((uuid) => uuid.toUpperCase()),
);

const numberArb = fc.oneof(
  fc.integer().map(String),
  fc
    .tuple(fc.integer({ min: -9999, max: 9999 }), fc.nat({ max: 99_999 }))
    .map(([a, b]) => `${a}.${b}`),
  fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }).map(String),
  fc.nat({ max: 999_999_999 }).map((n) => n.toLocaleString('en-US')),
);

const timestampArb = fc.oneof(
  fc.integer({ min: 0, max: 4_102_444_800_000 }).map((ms) => new Date(ms).toISOString()),
  fc.integer({ min: 0, max: 4_102_444_800_000 }).map((ms) => new Date(ms).toUTCString()),
);

const segmentsArb = fc.array(fc.constantFrom(...PATH_SEGMENTS), { minLength: 1, maxLength: 6 });

const windowsPathArb = fc
  .tuple(fc.constantFrom('C', 'D', 'E'), segmentsArb, fc.constantFrom(...FILE_NAMES))
  .map(([drive, segments, file]) => `${drive}:\\${[...segments, file].join('\\')}`);

const posixPathArb = fc
  .tuple(fc.constantFrom('/', '~/', './', '../'), segmentsArb, fc.constantFrom(...FILE_NAMES))
  .map(([root, segments, file]) => `${root}${[...segments, file].join('/')}`);

const urlArb = fc
  .tuple(
    fc.constantFrom('https', 'http'),
    fc.constantFrom(...HOSTS),
    fc.array(fc.constantFrom(...PATH_SEGMENTS, ...WORDS.slice(0, 20)), { maxLength: 5 }),
    fc.option(fc.tuple(fc.nat({ max: 99 }), fc.constantFrom('asc', 'desc')), { nil: undefined }),
    fc.option(fc.constantFrom('hook-input', 'usage', 'L42'), { nil: undefined }),
  )
  .map(([scheme, host, segments, query, fragment]) => {
    const pathPart = segments.map((segment) => encodeURIComponent(segment)).join('/');
    const queryPart = query === undefined ? '' : `?page=${query[0]}&sort=${query[1]}`;
    const fragmentPart = fragment === undefined ? '' : `#${fragment}`;
    return `${scheme}://${host}/${pathPart}${queryPart}${fragmentPart}`;
  });

/** A piece of ordinary text; `KEY=value` and source lines sit on their own line. */
const pieceArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: wordArb, weight: 6 },
  { arbitrary: numberArb, weight: 1 },
  { arbitrary: timestampArb, weight: 1 },
  { arbitrary: uuidArb, weight: 1 },
  { arbitrary: ulidArb, weight: 1 },
  { arbitrary: fc.oneof(hexArb(7), hexArb(12), hexArb(40), hexArb(64)), weight: 1 },
  { arbitrary: windowsPathArb, weight: 1 },
  { arbitrary: posixPathArb, weight: 1 },
  { arbitrary: urlArb, weight: 1 },
  {
    arbitrary: fc.constantFrom(...PLAIN_ENV_LINES, ...SOURCE_LINES).map((line) => `\n${line}\n`),
    weight: 1,
  },
);

/** Generated ordinary text built only from the negative shapes of clause 6. May be empty. */
export const ordinaryTextArb: fc.Arbitrary<string> = fc
  .array(fc.tuple(pieceArb, fc.constantFrom(' ', ' ', ' ', '\n', ', ', '; ')), { maxLength: 25 })
  .map((parts) => parts.map(([piece, sep], i) => (i === 0 ? piece : `${sep}${piece}`)).join(''));

/** What a secret may be wrapped in when it's embedded in text. */
export const WRAPPERS: readonly (readonly [string, string])[] = [
  [' ', ' '],
  ['\n', '\n'],
  ['"', '"'],
  ["'", "'"],
  ['(', ')'],
  ['`', '`'],
  [': ', '.'],
];
