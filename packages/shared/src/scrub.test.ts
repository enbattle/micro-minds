// The scrubber's example corpus (task 2.2 and its review rounds; PLAN §9 item 5, §11, D14),
// organized by behavior. Property-based tests are in scrub.property.test.ts; time bounds, huge
// inputs and fail-closed behavior are in scrub.performance.test.ts.
//
// Public surface under test (packages/shared/src/index.ts):
//   REDACTION_MARKER: string                                            what replaces a secret
//   scrubText(text: string): string
//   scrubRaw(value: unknown, options: { maxLength: number }): unknown
// scrubRaw's size is the length of JSON.stringify(result); the tests use ASCII only, so characters
// and bytes agree. Every token is built at runtime from a seed (scrub.test-helpers.ts), so the
// repo holds no token-shaped literal.
import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, scrubRaw, scrubText } from './index.ts';
import {
  ALNUM,
  BASE64,
  BASE64URL,
  base32Token,
  HIGH_ENTROPY_SHAPE,
  hexString,
  highEntropyToken,
  lowerToken,
  PLAIN_ENV_LINES,
  password,
  SECRET_SHAPES,
  SEEDS,
  SOURCE_LINES,
  sampleSecret,
  ulid,
  uuid,
} from './scrub.test-helpers.ts';

const M = REDACTION_MARKER;
const BIG = { maxLength: 1_000_000 };

/** A short secret value no other rule would catch (no known prefix, far below 40 chars). */
const VALUE = 'hunter2x9Qz';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected a plain object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

describe('REDACTION_MARKER', () => {
  it('is a non-empty string exported from the package surface', () => {
    expect(typeof REDACTION_MARKER).toBe('string');
    expect(REDACTION_MARKER.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------
// Known key shapes.
// -------------------------------------------------------------------------------------------

/** Neutral contexts: nothing around the secret names it one, so only a shape rule applies. */
const CONTEXTS: readonly { name: string; wrap: (secret: string) => string }[] = [
  { name: 'alone', wrap: (secret) => secret },
  { name: 'in a sentence', wrap: (secret) => `Found ${secret} in the log.` },
  { name: 'before a comma', wrap: (secret) => `We published with ${secret}, then rotated it.` },
  { name: 'in a command', wrap: (secret) => `echo ${secret} | pbcopy` },
  { name: 'on its own line', wrap: (secret) => `copied\n${secret}\n` },
];

describe('scrubText: known key shapes', () => {
  const rows = SECRET_SHAPES.flatMap((shape) =>
    CONTEXTS.map((context) => ({ name: `${shape.name}, ${context.name}`, shape, context })),
  );

  it.each(rows)('$name → only the secret is replaced (every seed)', ({ shape, context }) => {
    for (const seed of SEEDS) {
      const { secret, core } = shape.make(seed);
      const out = scrubText(context.wrap(secret));
      expect(out).toBe(context.wrap(M));
      expect(out).not.toContain(core);
    }
  });

  it.each(SECRET_SHAPES)('$name as a secret env value → key kept, value gone', ({ make }) => {
    const { secret, core } = make(7);
    const out = scrubText(`STRIPE_SECRET_KEY=${secret}\nPORT=3000`);
    expect(out).toBe(`STRIPE_SECRET_KEY=${M}\nPORT=3000`);
    expect(out).not.toContain(core);
  });

  const ant = sampleSecret('Anthropic');
  const ghp = sampleSecret('GitHub personal');
  const google = sampleSecret('Google');
  const aws = sampleSecret('AWS');
  const pemKey = sampleSecret('PEM RSA');

  it.each([
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
  ])('position: $name → only the secret is replaced', ({ input, expected }) => {
    expect(scrubText(input)).toBe(expected);
  });
});

// -------------------------------------------------------------------------------------------
// URL, header, bearer and flag forms.
// -------------------------------------------------------------------------------------------

describe('scrubText: URL passwords, auth headers, bearer tokens and secret flags', () => {
  const opaque = highEntropyToken(11, 32, BASE64URL);
  const jwt = sampleSecret('JWT');
  const basic = Buffer.from(`admin:${password(5)}`, 'utf8').toString('base64');
  const classic = hexString(6, 40);

  const urlRows = SEEDS.flatMap((seed) => {
    const pw = password(seed);
    return [
      {
        name: `URL password: env line DATABASE_URL #${seed}`,
        input: `DATABASE_URL=postgres://admin:${pw}@db:5432/app`,
        expected: `DATABASE_URL=postgres://admin:${M}@db:5432/app`,
        secret: pw,
      },
      {
        name: `URL password: quoted env line with a query #${seed}`,
        input: `export DATABASE_URL="postgresql://admin:${pw}@db.internal:5432/app?sslmode=require"`,
        expected: `export DATABASE_URL="postgresql://admin:${M}@db.internal:5432/app?sslmode=require"`,
        secret: pw,
      },
      {
        name: `URL password: in prose, with a + in the scheme #${seed}`,
        input: `connecting to mongodb+srv://app_user:${pw}@cluster0.example.net/test?retryWrites=true now`,
        expected: `connecting to mongodb+srv://app_user:${M}@cluster0.example.net/test?retryWrites=true now`,
        secret: pw,
      },
      {
        name: `URL password: in a git clone command #${seed}`,
        input: `git clone https://dev:${pw}@github.com/enbattle/micro-minds.git && cd micro-minds`,
        expected: `git clone https://dev:${M}@github.com/enbattle/micro-minds.git && cd micro-minds`,
        secret: pw,
      },
      {
        name: `URL password: empty user name #${seed}`,
        input: `redis://:${pw}@localhost:6379/0`,
        expected: `redis://:${M}@localhost:6379/0`,
        secret: pw,
      },
      {
        name: `URL password: in a JSON string value #${seed}`,
        input: `{"url":"amqp://guest:${pw}@rabbit:5672/vhost","retries":3}`,
        expected: `{"url":"amqp://guest:${M}@rabbit:5672/vhost","retries":3}`,
        secret: pw,
      },
    ];
  });

  it.each([
    ...urlRows,
    {
      name: 'URL password: a low-entropy password',
      input: 'DATABASE_URL=postgres://admin:hunter2@db:5432/app',
      expected: `DATABASE_URL=postgres://admin:${M}@db:5432/app`,
      secret: 'hunter2',
    },
    {
      name: 'URL password: percent-encoded',
      input: 'mysql://root:p%40ss%3Aword@127.0.0.1:3306/app',
      expected: `mysql://root:${M}@127.0.0.1:3306/app`,
      secret: 'p%40ss%3Aword',
    },
    {
      name: 'Bearer: Authorization header with an opaque token',
      input: `Authorization: Bearer ${opaque}`,
      expected: `Authorization: Bearer ${M}`,
      secret: opaque,
    },
    {
      name: 'Bearer: Authorization header with a JWT',
      input: `Authorization: Bearer ${jwt}`,
      expected: `Authorization: Bearer ${M}`,
      secret: jwt,
    },
    {
      name: 'Bearer: a short, low-entropy token still counts',
      input: 'Authorization: Bearer abc123def456',
      expected: `Authorization: Bearer ${M}`,
      secret: 'abc123def456',
    },
    {
      name: 'Bearer: lower-case header and scheme keep their case',
      input: `authorization: bearer ${opaque}`,
      expected: `authorization: bearer ${M}`,
      secret: opaque,
    },
    {
      name: 'Bearer: inside a curl command, the rest of the command is kept',
      input: `curl -H "Authorization: Bearer ${opaque}" https://api.example.com/v1/models`,
      expected: `curl -H "Authorization: Bearer ${M}" https://api.example.com/v1/models`,
      secret: opaque,
    },
    {
      name: 'Bearer: inside a JSON headers object',
      input: `{"headers":{"authorization":"Bearer ${opaque}","accept":"application/json"}}`,
      expected: `{"headers":{"authorization":"Bearer ${M}","accept":"application/json"}}`,
      secret: opaque,
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
  ])('$name', ({ input, expected, secret }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(secret);
  });

  it.each([
    { name: 'a URL with a port, no user info', input: 'https://example.com:8080/path/to/page' },
    {
      name: 'a URL with a user name, no password',
      input: 'ssh://git@github.com/enbattle/micro-minds.git',
    },
    { name: 'scp-style git remote', input: 'git@github.com:enbattle/micro-minds.git' },
    { name: 'mailto link', input: 'mailto:dev@example.com' },
    { name: 'an env URL with no user info', input: 'DATABASE_URL=postgres://localhost:5432/app' },
    { name: 'a time and an at-sign in prose', input: 'meet at 12:30@the office' },
    { name: 'prose using the word bearer', input: 'She was the bearer of bad news.' },
    { name: 'Basic in prose', input: 'Basic usage: run the token command first.' },
    { name: 'token in prose', input: 'The token expired, so the session restarted.' },
  ])('guard, unchanged: $name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

// -------------------------------------------------------------------------------------------
// Key-name rules: which keys name a secret, in every form a key appears in.
// -------------------------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UPPER_KEY = /^[A-Z][A-Z0-9_]*$/;

/** The text forms of `key=value`, and which keys each form can hold. */
const KEY_FORMS: readonly {
  name: string;
  holds: (key: string) => boolean;
  text: (key: string, value: string) => string;
}[] = [
  { name: 'env line', holds: (key) => IDENTIFIER.test(key), text: (k, v) => `${k}=${v}` },
  {
    name: 'export with double quotes',
    holds: (key) => IDENTIFIER.test(key),
    text: (k, v) => `export ${k}="${v}"`,
  },
  {
    name: 'shell assignment mid-line',
    holds: (key) => UPPER_KEY.test(key),
    text: (k, v) => `cd app && ${k}=${v} npm start`,
  },
  {
    name: 'quoted docker -e assignment',
    holds: (key) => UPPER_KEY.test(key),
    text: (k, v) => `docker run -e "${k}=${v}" img`,
  },
];

/** Keys that name a secret as one of their words, whatever the case style or the other words. */
const SECRET_KEYS: readonly { key: string; value?: string }[] = [
  { key: 'KEY' },
  { key: 'API_KEY' },
  { key: 'ANTHROPIC_API_KEY' },
  { key: 'AWS_SECRET_ACCESS_KEY' },
  { key: 'SECRET_KEY' },
  { key: 'SECRET_KEY_BASE' },
  { key: 'GITHUB_TOKEN' },
  { key: 'AUTH_TOKEN' },
  { key: 'CLIENT_SECRET' },
  { key: 'PASSWORD' },
  { key: 'DB_PASSWORD' },
  { key: 'DATABASE_PASSWORD' },
  { key: 'SERVICE_CREDENTIALS' },
  // `_`-separated parts: PASS, PWD and DSN count as a whole part.
  { key: 'PASS' },
  { key: 'DB_PASS' },
  { key: 'MAIL_PASS' },
  { key: 'DB_PWD' },
  { key: 'REDIS_PWD' },
  { key: 'SENTRY_DSN', value: 'https://hunter2@o0.ingest.example.io/42' },
  // A vendor or any other word before KEY.
  { key: 'STRIPE_KEY' },
  { key: 'OPENAI_KEY' },
  { key: 'APP_KEY' },
  { key: 'DB_KEY' },
  { key: 'DEPLOY_KEY' },
  { key: 'SESSION_KEY' },
  { key: 'SENDGRID_KEY' },
  { key: 'GOOGLE_MAPS_KEY' },
  { key: 'MY_KEY' },
  // A secret word followed by a word that can itself hold a secret.
  { key: 'VAULT_SECRET_ID', value: uuid(7) },
  { key: 'SECRET_ID' },
  { key: 'CLIENT_SECRET_ID' },
  { key: 'GITHUB_TOKEN_ID' },
  { key: 'API_TOKEN_NAME' },
  { key: 'SENTRY_DSN_URL', value: 'https://abc123def456@o1.ingest.sentry.io/1' },
  { key: 'ADMIN_PASSWORD_URL' },
  { key: 'MY_PASSWORD_PATH' },
  // Lower, camel and kebab case.
  { key: 'password' },
  { key: 'Password' },
  { key: 'token' },
  { key: 'secret' },
  { key: 'db_password' },
  { key: 'smtp_pass' },
  { key: 'api_key' },
  { key: 'secret_key' },
  { key: 'private_key' },
  { key: 'client_secret' },
  { key: 'stripe_key' },
  { key: 'apiKey' },
  { key: 'stripeKey' },
  { key: 'appKey' },
  { key: 'deployKey' },
  { key: 'clientSecret' },
  { key: 'accessToken' },
  { key: 'authToken' },
  { key: 'api-key' },
  { key: 'x-api-key' },
];

/**
 * Keys that don't name a secret: the word sits inside another word, the key is structural
 * (`primaryKey`, `keyPath`, an OTel attribute's `key`), or a descriptor follows the secret word.
 */
const NON_SECRET_KEYS: readonly string[] = [
  'TOKENIZERS_PARALLELISM',
  'KEYBOARD_LAYOUT',
  'MONKEY',
  'PASSENGER_COUNT',
  'BYPASS_CACHE',
  'OLDPWD',
  'tokenizer',
  'keyboard',
  'passenger',
  'monkey',
  'bypass',
  'tokenizerModel',
  'keyboardLayout',
  'passenger_count',
  'monkey-patch',
  'bypassCache',
  'key',
  'primaryKey',
  'sortKey',
  'partitionKey',
  'cacheKey',
  'foreign_key',
  'keyPath',
  'tokenType',
  'token_count',
  'max_tokens',
  'passThrough',
  'PASSWORD_MIN_LENGTH',
];

/** Values a structural key keeps, including ones that would look secret under a secret key. */
const STRUCTURAL_VALUES: readonly unknown[] = [
  'user_id',
  'session.id',
  'bearer',
  'hunter2',
  12,
  0,
  true,
];

describe('secret-named keys: the value goes, the key stays', () => {
  it.each(SECRET_KEYS.map(({ key, value }) => ({ name: key, key, value: value ?? VALUE })))(
    '$name in every text form it fits and in scrubRaw',
    ({ key, value }) => {
      for (const form of KEY_FORMS.filter((candidate) => candidate.holds(key))) {
        expect(scrubText(form.text(key, value)), form.name).toBe(form.text(key, M));
      }
      for (const v of [value, 'correct horse battery staple', 'dev']) {
        expect(scrubRaw({ env: { [key]: v }, note: v }, BIG)).toEqual({
          env: { [key]: M },
          note: v,
        });
      }
    },
  );

  it.each(NON_SECRET_KEYS.map((key) => ({ name: key, key })))(
    '$name keeps its value in every text form it fits and in scrubRaw',
    ({ key }) => {
      for (const form of KEY_FORMS.filter((candidate) => candidate.holds(key))) {
        const input = form.text(key, VALUE);
        expect(scrubText(input), form.name).toBe(input);
      }
      for (const value of STRUCTURAL_VALUES) {
        expect(scrubRaw({ [key]: value }, BIG)).toEqual({ [key]: value });
      }
    },
  );

  it.each([
    {
      name: 'OpenTelemetry attributes with user and session values',
      input: {
        attributes: [
          { key: 'user.email', value: { stringValue: 'user@example.com' } },
          { key: 'session.id', value: { stringValue: '00000000-0000-4000-8000-000000000001' } },
          { key: 'terminal.type', value: { stringValue: 'vscode' } },
        ],
      },
    },
    {
      name: 'OpenTelemetry resource attributes with an int value',
      input: {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude-code' } },
            { key: 'session.id', value: { stringValue: 'abc-123' } },
            { key: 'tokens', value: { intValue: 42 } },
          ],
        },
      },
    },
  ])('$name: every {key, value} keeps its key name', ({ input }) => {
    expect(scrubRaw(input, BIG)).toEqual(input);
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

describe('scrubRaw: OpenTelemetry fixture replay keeps every attribute key', () => {
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
// KEY=value lines, shell assignments, and quoted or nested assignments.
// -------------------------------------------------------------------------------------------

describe('scrubText: KEY=value lines in env-like content', () => {
  it.each([
    {
      name: 'export, no quotes',
      input: 'export GITHUB_TOKEN=plain-token-value',
      expected: `export GITHUB_TOKEN=${M}`,
    },
    {
      name: 'spaces around =',
      input: 'CLIENT_SECRET = hunter2',
      expected: `CLIENT_SECRET = ${M}`,
    },
    {
      name: 'double quotes',
      input: 'AWS_SECRET_ACCESS_KEY="hunter2"',
      expected: `AWS_SECRET_ACCESS_KEY="${M}"`,
    },
    {
      name: 'single quotes with spaces in the value',
      input: "DB_PASSWORD='correct horse battery staple'",
      expected: `DB_PASSWORD='${M}'`,
    },
    {
      name: 'export, spaces and quotes together',
      input: 'export DATABASE_PASSWORD = "p@ss w0rd!"',
      expected: `export DATABASE_PASSWORD = "${M}"`,
    },
    {
      name: 'spaces around = and quotes',
      input: 'REDIS_PWD = "hunter2"',
      expected: `REDIS_PWD = "${M}"`,
    },
    { name: 'indented', input: '  AUTH_TOKEN=hunter2', expected: `  AUTH_TOKEN=${M}` },
  ])('$name → value redacted, key kept', ({ input, expected }) => {
    expect(scrubText(input)).toBe(expected);
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
      '# local settings',
      'NODE_ENV=development',
      'PORT=3000',
      `API_KEY=${M}`,
      `export GITHUB_TOKEN=${M}`,
      'DATABASE_URL=postgres://localhost:5432/app',
      `DB_PASSWORD=${M}`,
      'LOG_LEVEL=debug',
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

  it('CRLF line endings are kept and the value does not swallow the \\r', () => {
    const input = 'NODE_ENV=production\r\nAPI_KEY=hunter2\r\nPORT=3000\r\n';
    expect(scrubText(input)).toBe(`NODE_ENV=production\r\nAPI_KEY=${M}\r\nPORT=3000\r\n`);
  });
});

describe('scrubText: a mid-line secret KEY=value is redacted in full and the command kept', () => {
  it.each([
    {
      name: 'after &&',
      input: 'cd app && API_KEY=hunter2 npm start',
      expected: `cd app && API_KEY=${M} npm start`,
      leaks: ['hunter2'],
    },
    {
      name: 'two assignments after env',
      input: 'env DB_PASSWORD=hunter2 GITHUB_TOKEN=hunter3 ./deploy.sh',
      expected: `env DB_PASSWORD=${M} GITHUB_TOKEN=${M} ./deploy.sh`,
      leaks: ['hunter'],
    },
    {
      name: 'docker -e, unquoted',
      input: 'docker run -e API_KEY=hunter2 --rm app:latest',
      expected: `docker run -e API_KEY=${M} --rm app:latest`,
      leaks: ['hunter2'],
    },
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
  ])('$name', ({ input, expected, leaks }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    for (const leak of leaks) expect(out).not.toContain(leak);
  });

  it.each([
    { name: 'a plain value', input: 'cd app && NODE_ENV=production npm start' },
    { name: 'a comma list', input: 'cd app && NODE_OPTIONS=a,b,c npm start' },
    { name: 'parentheses', input: 'env LABEL=(dev) npm start' },
    { name: 'a backslash', input: 'env OUT_DIR=build\\win run' },
  ])('guard, a non-secret key is unchanged: $name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

describe('scrubText: a secret KEY=value after a quote or punctuation is redacted, the rest kept', () => {
  it.each([
    {
      name: 'docker -e with double quotes',
      input: 'docker run -e "DB_PASSWORD=hunter2" img',
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
      leaks: ['hunter2'],
    },
    {
      name: 'docker -e with single quotes',
      input: "docker run -e 'API_KEY=hunter2' img",
      expected: `docker run -e 'API_KEY=${M}' img`,
      leaks: ['hunter2'],
    },
    {
      name: '--env="…" flag',
      input: 'docker run --env="API_KEY=hunter2" img',
      expected: `docker run --env="API_KEY=${M}" img`,
      leaks: ['hunter2'],
    },
    {
      name: 'env with a quoted assignment',
      input: 'env "API_KEY=hunter2" ./run',
      expected: `env "API_KEY=${M}" ./run`,
      leaks: ['hunter2'],
    },
    {
      name: 'Windows cmd set with quotes',
      input: 'set "API_KEY=hunter2"',
      expected: `set "API_KEY=${M}"`,
      leaks: ['hunter2'],
    },
    {
      name: 'Windows cmd set with quotes, then a command',
      input: 'set "API_KEY=hunter2" && node server.js',
      expected: `set "API_KEY=${M}" && node server.js`,
      leaks: ['hunter2'],
    },
    {
      name: 'kubectl --from-literal (after =)',
      input: 'kubectl create secret generic s --from-literal=DB_PASSWORD=hunter2',
      expected: `kubectl create secret generic s --from-literal=DB_PASSWORD=${M}`,
      leaks: ['hunter2'],
    },
    {
      name: 'kubectl --from-literal followed by another flag',
      input: 'kubectl create secret generic s --from-literal=DB_PASSWORD=hunter2 --dry-run=client',
      expected: `kubectl create secret generic s --from-literal=DB_PASSWORD=${M} --dry-run=client`,
      leaks: ['hunter2'],
    },
    {
      name: 'JSON array of env strings',
      input: '["DB_PASSWORD=hunter2","NODE_ENV=production"]',
      expected: `["DB_PASSWORD=${M}","NODE_ENV=production"]`,
      leaks: ['hunter2'],
    },
    {
      name: 'JSON array, secret second (after a comma and a quote)',
      input: '["NODE_ENV=production","DB_PASSWORD=hunter2"]',
      expected: `["NODE_ENV=production","DB_PASSWORD=${M}"]`,
      leaks: ['hunter2'],
    },
    {
      name: 'in parentheses',
      input: '(DB_PASSWORD=hunter2)',
      expected: `(DB_PASSWORD=${M})`,
      leaks: ['hunter2'],
    },
    {
      name: 'in square brackets',
      input: '[API_KEY=hunter2]',
      expected: `[API_KEY=${M}]`,
      leaks: ['hunter2'],
    },
    {
      name: 'after a comma',
      input: 'gcloud run deploy app --set-env-vars=NODE_ENV=production,DB_PASSWORD=hunter2',
      expected: `gcloud run deploy app --set-env-vars=NODE_ENV=production,DB_PASSWORD=${M}`,
      leaks: ['hunter2'],
    },
    {
      name: 'after a colon',
      input: 'env:API_KEY=hunter2',
      expected: `env:API_KEY=${M}`,
      leaks: ['hunter2'],
    },
    {
      name: 'after a literal \\n escape, at the end',
      input: 'NODE_ENV=production\\nDB_PASSWORD=hunter2',
      expected: `NODE_ENV=production\\nDB_PASSWORD=${M}`,
      leaks: ['hunter2'],
    },
    {
      name: 'between literal \\n escapes (JSON-escaped .env content)',
      input: '{"stdout":"NODE_ENV=production\\nDB_PASSWORD=hunter2\\nPORT=3000\\n"}',
      expected: `{"stdout":"NODE_ENV=production\\nDB_PASSWORD=${M}\\nPORT=3000\\n"}`,
      leaks: ['hunter2'],
    },
    // Quoted: the value runs to the matching closing quote, whatever it holds.
    {
      name: 'quoted value with a comma and punctuation',
      input: 'docker run -e "DB_PASSWORD=P@ss,w0rd!" img',
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
      leaks: ['P@ss', 'w0rd'],
    },
    {
      name: 'quoted value with spaces',
      input: 'docker run -e "API_TOKEN=my very s3cret value" img',
      expected: `docker run -e "API_TOKEN=${M}" img`,
      leaks: ['my very', 's3cret', 'value'],
    },
    {
      name: 'quoted value with parentheses',
      input: 'docker run -e "DB_PASSWORD=pa(ss)w0rd9" img',
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
      leaks: ['pa(', 'ss)', 'w0rd9'],
    },
    {
      name: 'quoted value with brackets',
      input: 'docker run -e "SECRET_KEY=ab[cd]ef9x" img',
      expected: `docker run -e "SECRET_KEY=${M}" img`,
      leaks: ['ab[', 'cd]', 'ef9x'],
    },
    {
      name: 'quoted value with backslashes',
      input: 'docker run -e "DB_PASSWORD=pa\\ss\\w0rd9" img',
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
      leaks: ['pa\\', 'ss\\', 'w0rd9'],
    },
    {
      name: 'single quotes inside a double-quoted value',
      input: `docker run -e "DB_PASSWORD=it's'pw0rd9" img`,
      expected: `docker run -e "DB_PASSWORD=${M}" img`,
      leaks: ["it's", 'pw0rd9'],
    },
    {
      name: 'single-quoted value with spaces and a comma',
      input: "docker run -e 'DB_PASSWORD=P@ss, w0rd!' img",
      expected: `docker run -e 'DB_PASSWORD=${M}' img`,
      leaks: ['P@ss', 'w0rd'],
    },
    {
      name: 'quoted value with a comma inside a JSON array',
      input: '["DB_PASSWORD=P@ss,w0rd!", "NODE_ENV=production"]',
      expected: `["DB_PASSWORD=${M}", "NODE_ENV=production"]`,
      leaks: ['P@ss', 'w0rd'],
    },
    // Nested quotes: a secret quoted inside a non-secret quoted assignment.
    {
      name: 'nested: double-quoted secret in single-quoted sh -c, comma and space',
      input: `sh -c 'DEBUG=1 docker run -e "API_KEY=P@ss,w0rd x" img'`,
      expected: `sh -c 'DEBUG=1 docker run -e "API_KEY=${M}" img'`,
      leaks: ['P@ss', 'w0rd'],
    },
    {
      name: 'nested: single-quoted secret in double-quoted sh -c, comma and space',
      input: `sh -c "DEBUG=1 docker run -e 'API_KEY=P@ss,w0rd x' img"`,
      expected: `sh -c "DEBUG=1 docker run -e 'API_KEY=${M}' img"`,
      leaks: ['P@ss', 'w0rd'],
    },
    {
      name: 'nested: double-quoted secret in single quotes, spaces only',
      input: `sh -c 'DEBUG=1 docker run -e "API_KEY=my s3cret value" img'`,
      expected: `sh -c 'DEBUG=1 docker run -e "API_KEY=${M}" img'`,
      leaks: ['my s3cret', 's3cret', 'value'],
    },
    {
      name: 'nested: single-quoted secret in double quotes, spaces only',
      input: `sh -c "DEBUG=1 docker run -e 'API_KEY=my s3cret value' img"`,
      expected: `sh -c "DEBUG=1 docker run -e 'API_KEY=${M}' img"`,
      leaks: ['my s3cret', 's3cret', 'value'],
    },
    {
      name: 'nested: double-quoted secret in single quotes, brackets',
      input: `sh -c 'DEBUG=1 docker run -e "API_KEY=ab[cd]ef9x" img'`,
      expected: `sh -c 'DEBUG=1 docker run -e "API_KEY=${M}" img'`,
      leaks: ['ab[', 'cd]', 'ef9x'],
    },
    {
      name: 'nested: single-quoted secret in double quotes, brackets',
      input: `sh -c "DEBUG=1 docker run -e 'API_KEY=ab[cd]ef9x' img"`,
      expected: `sh -c "DEBUG=1 docker run -e 'API_KEY=${M}' img"`,
      leaks: ['ab[', 'cd]', 'ef9x'],
    },
    // Where the value ends outside quotes: at the punctuation that closes its context.
    {
      name: 'quoted: the value ends at the first closing quote on the line',
      input: 'echo "DB_PASSWORD=abc123" && echo "hi there"',
      expected: `echo "DB_PASSWORD=${M}" && echo "hi there"`,
      leaks: ['abc123'],
    },
    {
      name: 'after ( the value ends at the comma',
      input: 'f(API_KEY=abc123,other)',
      expected: `f(API_KEY=${M},other)`,
      leaks: ['abc123'],
    },
    {
      name: 'after [ the value ends at the bracket',
      input: 'args [API_KEY=abc123] done',
      expected: `args [API_KEY=${M}] done`,
      leaks: ['abc123'],
    },
    {
      name: 'after , the value ends at the next comma',
      input: 'A=1,API_KEY=abc123,B=2',
      expected: `A=1,API_KEY=${M},B=2`,
      leaks: ['abc123'],
    },
    {
      name: 'after : the value ends at the comma',
      input: 'env:API_KEY=abc123,next',
      expected: `env:API_KEY=${M},next`,
      leaks: ['abc123'],
    },
    {
      name: 'after = the value ends at the parenthesis',
      input: 'set(opt=API_KEY=abc123) ok',
      expected: `set(opt=API_KEY=${M}) ok`,
      leaks: ['abc123'],
    },
  ])('$name', ({ input, expected, leaks }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    for (const leak of leaks) expect(out).not.toContain(leak);
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
    { name: 'single-quoted sh -c', input: `sh -c 'DEBUG=1 npm start'` },
    { name: 'double-quoted sh -c', input: `sh -c "DEBUG=1 npm start"` },
  ])('guard, a non-secret key is unchanged: $name', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});

// -------------------------------------------------------------------------------------------
// Source code is not env content.
// -------------------------------------------------------------------------------------------

describe('scrubText: source-code assignments of code, names and literals stay unchanged', () => {
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
    { name: 'dotted name, indented', input: '    key = item.name' },
    { name: 'dotted name', input: 'token = config.token' },
    { name: 'dotted name with _', input: '    password = config.db_password' },
    { name: 'three-segment dotted name', input: '  token = self.settings.token' },
    { name: 'Python None, indented', input: '    token = None' },
    { name: 'JS null', input: 'password = null' },
    { name: 'JS undefined', input: 'secret = undefined' },
    { name: 'Python True', input: 'api_key = True' },
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

  it.each([
    {
      name: 'a double-quoted string literal',
      lead: 'API_KEY = ',
      value: '"hunter2"',
      expected: `API_KEY = "${M}"`,
    },
    {
      name: 'a single-quoted string literal',
      lead: 'password = ',
      value: "'hunter2'",
      expected: `password = '${M}'`,
    },
    {
      name: 'a literal word with no spaces',
      lead: 'PASSWORD=',
      value: 'True',
      expected: `PASSWORD=${M}`,
    },
    // A dotted value is only code when every segment is lower-case letters, `_` or `$`.
    {
      name: 'a dotted passphrase with capitals',
      lead: 'password = ',
      value: 'Correct.Horse.Battery',
      expected: `password = ${M}`,
    },
    {
      name: 'a dotted passphrase, indented constant name',
      lead: '  DB_PASSWORD = ',
      value: 'Summer.Time',
      expected: `  DB_PASSWORD = ${M}`,
    },
    {
      name: 'a dotted passphrase, indented in an ini section (.pypirc)',
      lead: '[pypi]\n  password = ',
      value: 'My.Pass.Word',
      expected: `[pypi]\n  password = ${M}`,
    },
    {
      name: 'a dotted passphrase, tab-indented',
      lead: '\tSECRET_KEY = ',
      value: 'Red.Apple.Pie',
      expected: `\tSECRET_KEY = ${M}`,
    },
    {
      name: 'a dotted value with digits and capitals',
      lead: '  DB_PASSWORD = ',
      value: 'hunter2.x9Kq7Zp',
      expected: `  DB_PASSWORD = ${M}`,
    },
    {
      name: 'a dotted value with digits in its segments',
      lead: '    password = ',
      value: 's3cr3t_v4lue.pr0d',
      expected: `    password = ${M}`,
    },
    {
      name: 'a dotted value with a JWT-like header',
      lead: '  password = ',
      value: 'pk.eyJhbGciOi.aB3dEfGhIjKlMnOpQrStUv',
      expected: `  password = ${M}`,
    },
  ])('guard, still redacted: $name', ({ lead, value, expected }) => {
    const out = scrubText(`${lead}${value}`);
    expect(out).toBe(expected);
    for (const segment of value.replace(/["']/g, '').split('.')) {
      expect(out).not.toContain(segment);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Long runs: random tokens go, names, hashes and ids stay.
// -------------------------------------------------------------------------------------------

describe('scrubText: long random tokens with no known shape are redacted', () => {
  const rows = [
    { name: '40 mixed-case alphanumerics', token: highEntropyToken(101, 40, ALNUM) },
    { name: '64 mixed-case alphanumerics', token: highEntropyToken(102, 64, ALNUM) },
    { name: '40 base64 chars with + and /', token: highEntropyToken(103, 40, BASE64) },
    { name: '48 base64url chars with - and _', token: highEntropyToken(104, 48, BASE64URL) },
    ...SEEDS.flatMap((seed) => [
      { name: `40 mixed-case alphanumerics #${seed}`, token: highEntropyToken(seed, 40, ALNUM) },
      {
        name: `48 base64url chars #${seed}`,
        token: highEntropyToken(seed, 48, BASE64URL),
      },
      {
        name: `generated high-entropy token #${seed}`,
        token: HIGH_ENTROPY_SHAPE.make(seed).secret,
      },
      ...[40, 52, 64].flatMap((length) => [
        { name: `lower-case alphanumeric, ${length} #${seed}`, token: lowerToken(seed, length) },
        { name: `upper-case base32, ${length} #${seed}`, token: base32Token(seed, length) },
      ]),
    ]),
  ];

  it.each(rows)('$name → the marker, alone and in a sentence', ({ token }) => {
    expect(scrubText(token)).toBe(M);
    expect(scrubText(`session secret: ${token} (rotated)`)).toBe(`session secret: ${M} (rotated)`);
    expect(scrubText(`The TOTP seed is ${token}, rotate it.`)).toBe(
      `The TOTP seed is ${M}, rotate it.`,
    );
  });
});

describe('scrubText: names, hashes and ids stay unchanged', () => {
  const rows = [
    {
      name: 'camelCase identifier with digits',
      input: 'handleOAuth2CallbackForGitHubEnterpriseServer',
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
    { name: 'kebab-case name', input: 'micro-minds-server-core-integration-tests-runner' },
    { name: 'constant name', input: 'MAXIMUM_CONCURRENT_AGENT_SESSIONS_PER_WORKSPACE' },
    {
      name: 'snake_case name',
      input: 'replay_fixture_events_through_reducer_and_snapshot_world_state',
    },
    {
      name: 'kebab-case package in a command',
      input: 'npm run test -w @micro-minds/server-core-integration-tests-runner-helpers',
    },
    {
      name: 'kebab name with short letter-and-digit parts',
      input: 'k8s-deployment-manifest-for-production-cluster-eu-west-1',
    },
    {
      name: 'kebab name with python3',
      input: 'python3-pip-install-requirements-ubuntu2204-docker',
    },
    {
      name: 'constant name with S3 and V2',
      input: 'MAX_RETRIES_FOR_S3_UPLOAD_V2_TIMEOUT_IN_SECONDS_DEFAULT',
    },
    {
      name: 'snake name with utf8 and base64',
      input: 'test_should_handle_utf8_and_base64_encoded_payloads',
    },
    {
      name: 'kebab name with 2fa and oauth2',
      input: 'add-2fa-support-to-the-oauth2-callback-flow',
    },
    // 39 characters, under the 40-character run length: a guard on its own.
    { name: 'kebab name of 39 characters', input: 'strengths-and-weaknesses-review-2024-q3' },
    // Past 40 characters, so the consonant run in "strengths" is exercised.
    {
      name: 'kebab name with a consonant run',
      input: 'strengths-and-weaknesses-review-2024-q3-final',
    },
    {
      name: 'a Google search URL',
      input: 'https://www.google.com/search?q=how+to+install+python3+on+windows+11+step',
    },
    { name: 'UUID', input: '550e8400-e29b-41d4-a716-446655440000' },
    { name: 'upper-case UUID', input: 'F47AC10B-58CC-4372-A567-0E02B2C3D479' },
    { name: 'ULID', input: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    { name: 'ULID session id', input: 'session 01K6A2B3C4D5E6F7G8H9J0K1M2 started' },
    { name: 'short git hash', input: 'commit 2d8c3a8' },
    {
      name: 'git log line',
      input:
        '2d8c3a8 feat(shared): add event schemas, severity rules and the world-state reducer (2.1)',
    },
    ...SEEDS.flatMap((seed) => [
      { name: `SHA-1 hash #${seed}`, input: hexString(seed, 40) },
      { name: `SHA-256 hash #${seed}`, input: hexString(seed, 64) },
      { name: `commit line with a SHA-1 #${seed}`, input: `commit ${hexString(seed, 40)}` },
      { name: `generated ULID #${seed}`, input: ulid(seed) },
      { name: `worktree- + 40 hex #${seed}`, input: `worktree-${hexString(seed, 40)}` },
      {
        name: `node-cache-linux-x64-npm- + 64 hex #${seed}`,
        input: `node-cache-linux-x64-npm-${hexString(seed, 64)}`,
      },
      {
        name: `python3.11-venv-cache- + 32 hex #${seed}`,
        input: `python3.11-venv-cache-${hexString(seed, 32)}`,
      },
      { name: `sha256- + 64 hex #${seed}`, input: `sha256-${hexString(seed, 64)}` },
      {
        name: `cache key after "key:" #${seed}`,
        input: `Restored cache from key: node-cache-linux-x64-npm-${hexString(seed, 64)} (12 MB)`,
      },
    ]),
  ];

  it.each(rows)('$name: alone, in a sentence and as a scrubRaw value', ({ input }) => {
    expect(scrubText(input)).toBe(input);
    const sentence = `Running ${input} now, see the log.`;
    expect(scrubText(sentence)).toBe(sentence);
    expect(scrubRaw({ description: input }, BIG)).toEqual({ description: input });
  });
});

describe('scrubText: ordinary text is left unchanged', () => {
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

// -------------------------------------------------------------------------------------------
// scrubRaw: structure, masking under secret keys, keys, cycles, depth, truncation and caps.
// -------------------------------------------------------------------------------------------

describe('scrubRaw: structured values', () => {
  const ant = sampleSecret('Anthropic');
  const ghp = sampleSecret('GitHub personal');
  const bearer = highEntropyToken(12, 32, BASE64URL);

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
    {
      name: 'a Bash command with a mid-line secret',
      input: { tool_name: 'Bash', tool_input: { command: 'cd app && API_KEY=hunter2 npm start' } },
      expected: { tool_name: 'Bash', tool_input: { command: `cd app && API_KEY=${M} npm start` } },
    },
    {
      name: 'a Bash command with a comma in a mid-line secret',
      input: {
        tool_name: 'Bash',
        tool_input: { command: 'cd app && DB_PASSWORD=P@ss,w0rd! npm start' },
      },
      expected: {
        tool_name: 'Bash',
        tool_input: { command: `cd app && DB_PASSWORD=${M} npm start` },
      },
    },
    {
      name: 'a Bash command with a quoted secret assignment',
      input: {
        tool_name: 'Bash',
        tool_input: { command: 'docker run -e "DB_PASSWORD=hunter2" img' },
      },
      expected: {
        tool_name: 'Bash',
        tool_input: { command: `docker run -e "DB_PASSWORD=${M}" img` },
      },
    },
    {
      name: 'a URL password in a nested value',
      input: { env: { DATABASE_URL: `postgres://admin:${password(99)}@db:5432/app` } },
      expected: { env: { DATABASE_URL: `postgres://admin:${M}@db:5432/app` } },
    },
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
});

describe('scrubRaw: values under a secret-named key are masked', () => {
  it('secret keys nested in objects and arrays are masked, their siblings kept', () => {
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

  it('null under a secret key stays null or becomes the marker', () => {
    const out = asRecord(scrubRaw({ token: null }, BIG));
    expect([null, M]).toContain(out.token);
  });

  const ghp = sampleSecret('GitHub personal');

  it.each([
    {
      name: 'non-secret keys keep their values',
      input: { password: { hint: 'dev', length: 12, rotated: true } },
      expected: { password: { hint: 'dev', length: 12, rotated: true } },
    },
    {
      name: 'strings scrubbed as usual, nested secret keys masked',
      input: {
        credentials: {
          username: 'dev',
          region: 'eu-west-1',
          note: `rotated ${ghp} yesterday`,
          apiKey: 'hunter2',
          retries: 3,
        },
      },
      expected: {
        credentials: {
          username: 'dev',
          region: 'eu-west-1',
          note: `rotated ${M} yesterday`,
          apiKey: M,
          retries: 3,
        },
      },
    },
  ])('an object under a secret key is scrubbed by its own keys: $name', ({ input, expected }) => {
    expect(scrubRaw(input, BIG)).toEqual(expected);
  });
});

describe('scrubRaw: object keys are scrubbed and own __proto__ keys stay data', () => {
  const ghp = sampleSecret('GitHub personal');
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

describe('scrubRaw: the size cap', () => {
  const ghp = sampleSecret('GitHub personal');
  const bearer = highEntropyToken(12, 32, BASE64URL);

  it('a value exactly at the cap is kept whole', () => {
    const value = { note: 'x'.repeat(100) };
    const cap = JSON.stringify(value).length;
    expect(scrubRaw(value, { maxLength: cap })).toEqual(value);
  });

  it('a value one character over the cap is truncated and marked as truncated', () => {
    const value = { note: 'x'.repeat(100) };
    const cap = JSON.stringify(value).length - 1;
    expect(scrubRaw(value, { maxLength: cap })).toMatchObject({ truncated: true });
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
      const project = sampleSecret('OpenAI project');
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

// -------------------------------------------------------------------------------------------
// Odd input: never throws, always serializes, deterministic.
// -------------------------------------------------------------------------------------------

describe('the scrubbers never throw on odd values and are deterministic', () => {
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
      `x ${sampleSecret('Anthropic', 1)} y`,
      `Authorization: Bearer ${highEntropyToken(5, 32)}`,
      'API_KEY=hunter2',
      `${sampleSecret('GitHub personal', 2)} and ${sampleSecret('Slack', 3)}`,
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
