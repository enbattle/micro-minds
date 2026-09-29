// Task 2.2-fix3: scrubber review findings left open after 2.2-fix2. Clauses:
//   J1 label-joined hex vendor tokens (RubyGems, Shippo, Sourcegraph, Lob) are redacted whole,
//      while label-joined hashes that are names stay unchanged
//   J2 a secret KEY=value in quotes nested inside a non-secret quoted assignment is redacted up to
//      its own closing quote
//   (J3 pins the seed of a property in scrub.revision.test.ts; nothing to add here.)
//
// Public surface under test (packages/shared/src/index.ts): REDACTION_MARKER, scrubText(text).
// Every token and hash is generated at runtime from a seed, so the repo holds no token literal.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, scrubText } from './index.ts';
import { hexString } from './scrub.fix.test-helpers.ts';
import { chars, HEX, prng } from './scrub.test-helpers.ts';

const M = REDACTION_MARKER;
const SEEDS = [1, 2, 3, 20_260_928] as const;
const FC_SEED = 20_260_928;

// -------------------------------------------------------------------------------------------
// J1: label-joined hex vendor tokens.
// -------------------------------------------------------------------------------------------

interface HexToken {
  token: string;
  /** Random hex parts of the token; none may survive scrubbing. */
  parts: readonly string[];
}

interface HexTokenShape {
  name: string;
  make: (seed: number) => HexToken;
}

function labelled(label: string, length: number): (seed: number) => HexToken {
  return (seed) => {
    const hex = hexString(seed, length);
    return { token: `${label}${hex}`, parts: [hex] };
  };
}

function sourcegraphLong(seed: number): HexToken {
  const next = prng(seed);
  const first = chars(next, 16, HEX);
  const second = chars(next, 40, HEX);
  return { token: `sgp_${first}_${second}`, parts: [first, second] };
}

const VENDOR_SHAPES: readonly HexTokenShape[] = [
  { name: 'RubyGems rubygems_ + 48 hex', make: labelled('rubygems_', 48) },
  { name: 'Shippo shippo_live_ + 40 hex', make: labelled('shippo_live_', 40) },
  { name: 'Shippo shippo_test_ + 40 hex', make: labelled('shippo_test_', 40) },
  { name: 'Sourcegraph sgp_ + 40 hex', make: labelled('sgp_', 40) },
  { name: 'Sourcegraph sgp_ + 16 hex + _ + 40 hex', make: sourcegraphLong },
  { name: 'Lob live_ + 35 hex', make: labelled('live_', 35) },
  { name: 'Lob test_ + 35 hex', make: labelled('test_', 35) },
];

/** Neutral contexts: nothing around the token names it a secret, so only a token rule applies. */
const CONTEXTS: readonly { name: string; wrap: (token: string) => string }[] = [
  { name: 'alone', wrap: (token) => token },
  { name: 'in a sentence', wrap: (token) => `We published with ${token}, then rotated it.` },
  { name: 'in a command', wrap: (token) => `echo ${token} | pbcopy` },
  { name: 'at the end of a line', wrap: (token) => `copied\n${token}\n` },
];

describe('J1: label-joined hex vendor tokens are redacted whole', () => {
  const rows = VENDOR_SHAPES.flatMap((shape) =>
    SEEDS.flatMap((seed) =>
      CONTEXTS.map((context) => {
        const { token, parts } = shape.make(seed);
        return {
          name: `${shape.name}, ${context.name} #${seed}`,
          input: context.wrap(token),
          expected: context.wrap(M),
          parts,
        };
      }),
    ),
  );

  it.each(rows)('$name → the redaction marker, no part survives', ({ input, expected, parts }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    for (const part of parts) expect(out).not.toContain(part);
  });

  it.each(VENDOR_SHAPES.map((shape) => ({ name: shape.name, make: shape.make })))(
    'property: a random $name is redacted in any neutral context',
    ({ make }) => {
      fc.assert(
        fc.property(
          fc.integer(),
          fc.constantFrom(...CONTEXTS),
          fc.constantFrom(' ', '\n', '(', '"', "'"),
          (seed, context, before) => {
            const { token, parts } = make(seed);
            const closing = before === '(' ? ')' : before;
            const input = context.wrap(`${before}${token}${closing}`);
            const out = scrubText(input);
            expect(out).toBe(context.wrap(`${before}${M}${closing}`));
            for (const part of parts) expect(out).not.toContain(part);
          },
        ),
        { seed: FC_SEED, numRuns: 100 },
      );
    },
  );
});

// Guards: these pass today and must keep passing.
describe('J1 guard: label-joined hashes that are names stay, other hex vendor tokens still go', () => {
  const names = SEEDS.flatMap((seed) => [
    { name: `worktree- + 40 hex #${seed}`, input: `worktree-${hexString(seed, 40)}` },
    { name: `sha256- + 64 hex #${seed}`, input: `sha256-${hexString(seed, 64)}` },
    {
      name: `node-cache-linux-x64-npm- + 64 hex #${seed}`,
      input: `node-cache-linux-x64-npm-${hexString(seed, 64)}`,
    },
  ]);

  it.each(names)('guard: $name stays unchanged, alone and in a sentence', ({ input }) => {
    expect(scrubText(input)).toBe(input);
    const sentence = `Restored ${input} in 3s.`;
    expect(scrubText(sentence)).toBe(sentence);
  });

  const vendors = SEEDS.flatMap((seed) => [
    { name: `Pulumi pul- + 40 hex #${seed}`, hex: hexString(seed, 40), label: 'pul-' },
    { name: `Buildkite bkua_ + 40 hex #${seed}`, hex: hexString(seed, 40), label: 'bkua_' },
  ]);

  it.each(vendors)('guard: $name is still redacted', ({ hex, label }) => {
    expect(scrubText(`${label}${hex}`)).toBe(M);
    const out = scrubText(`We published with ${label}${hex}, then rotated it.`);
    expect(out).toBe(`We published with ${M}, then rotated it.`);
    expect(out).not.toContain(hex);
  });
});

// -------------------------------------------------------------------------------------------
// J2: a quoted secret KEY=value nested inside a non-secret quoted assignment.
// -------------------------------------------------------------------------------------------

describe('J2: a nested quoted secret KEY=value is redacted up to its own closing quote', () => {
  it.each([
    {
      name: 'double-quoted secret inside a single-quoted sh -c, comma and space in the value',
      input: `sh -c 'DEBUG=1 docker run -e "API_KEY=P@ss,w0rd x" img'`,
      expected: `sh -c 'DEBUG=1 docker run -e "API_KEY=${M}" img'`,
      parts: ['P@ss', 'w0rd'],
    },
    {
      name: 'single-quoted secret inside a double-quoted sh -c, comma and space in the value',
      input: `sh -c "DEBUG=1 docker run -e 'API_KEY=P@ss,w0rd x' img"`,
      expected: `sh -c "DEBUG=1 docker run -e 'API_KEY=${M}' img"`,
      parts: ['P@ss', 'w0rd'],
    },
    {
      name: 'double-quoted secret inside single quotes, space only in the value',
      input: `sh -c 'DEBUG=1 docker run -e "API_KEY=my s3cret value" img'`,
      expected: `sh -c 'DEBUG=1 docker run -e "API_KEY=${M}" img'`,
      parts: ['my s3cret', 's3cret', 'value'],
    },
    {
      name: 'single-quoted secret inside double quotes, space only in the value',
      input: `sh -c "DEBUG=1 docker run -e 'API_KEY=my s3cret value' img"`,
      expected: `sh -c "DEBUG=1 docker run -e 'API_KEY=${M}' img"`,
      parts: ['my s3cret', 's3cret', 'value'],
    },
    {
      name: 'double-quoted secret inside single quotes, brackets in the value',
      input: `sh -c 'DEBUG=1 docker run -e "API_KEY=ab[cd]ef9x" img'`,
      expected: `sh -c 'DEBUG=1 docker run -e "API_KEY=${M}" img'`,
      parts: ['ab[', 'cd]', 'ef9x'],
    },
    {
      name: 'single-quoted secret inside double quotes, brackets in the value',
      input: `sh -c "DEBUG=1 docker run -e 'API_KEY=ab[cd]ef9x' img"`,
      expected: `sh -c "DEBUG=1 docker run -e 'API_KEY=${M}' img"`,
      parts: ['ab[', 'cd]', 'ef9x'],
    },
  ])('$name → context kept, no part of the value survives', ({ input, expected, parts }) => {
    const out = scrubText(input);
    expect(out).toBe(expected);
    for (const part of parts) expect(out).not.toContain(part);
  });

  // Guards: these pass today and must keep passing.
  it.each([
    { name: "single-quoted sh -c 'DEBUG=1 npm start'", input: `sh -c 'DEBUG=1 npm start'` },
    { name: 'double-quoted sh -c "DEBUG=1 npm start"', input: `sh -c "DEBUG=1 npm start"` },
  ])('guard: an outer non-secret quoted assignment, $name, stays unchanged', ({ input }) => {
    expect(scrubText(input)).toBe(input);
  });
});
