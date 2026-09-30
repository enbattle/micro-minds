// Property-based tests for the scrubber (task 2.2 and its review rounds) with fast-check. The
// example corpus is in scrub.test.ts.
//
// Every property runs from a fixed seed (FC_SEED), so a run is the same on every machine and in CI:
// an unseeded property can draw a new counterexample on any run and fail at random. To explore
// further, change the seed locally and turn any counterexample into a row in scrub.test.ts.
//
// Surface under test (packages/shared/src/index.ts): REDACTION_MARKER, scrubText, scrubRaw.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, scrubRaw, scrubText } from './index.ts';
import {
  base32Token,
  constantNameArb,
  digitFreeToken,
  embeddingArb,
  HIGH_ENTROPY_SHAPE,
  hexString,
  kebabNameArb,
  LETTERS,
  lowerToken,
  NAME_WORDS,
  ordinaryTextArb,
  SECRET_SHAPES,
  snakeNameArb,
  surround,
  ulid,
} from './scrub.test-helpers.ts';

const M = REDACTION_MARKER;
const BIG = { maxLength: 1_000_000 };

/** The one seed every property runs from. */
const FC_SEED = 20_260_928;

const ALL_SHAPES = [...SECRET_SHAPES, HIGH_ENTROPY_SHAPE];

describe('property: no generated secret survives scrubbing', () => {
  it.each(ALL_SHAPES)(
    '$name, embedded anywhere in ordinary text, is replaced and nothing else changes',
    ({ make }) => {
      fc.assert(
        fc.property(fc.integer(), embeddingArb, (seed, embedding) => {
          const { secret, core } = make(seed);
          const { head, tail } = surround(embedding);
          const out = scrubText(`${head}${secret}${tail}`);
          expect(out).not.toContain(secret);
          expect(out).not.toContain(core);
          expect(out).toBe(`${head}${M}${tail}`);
        }),
        { seed: FC_SEED, numRuns: 100 },
      );
    },
  );

  it('several secrets of different shapes in one text: none survives', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: ALL_SHAPES.length - 1 }), fc.integer(), ordinaryTextArb), {
          minLength: 2,
          maxLength: 6,
        }),
        (parts) => {
          const samples = parts.map(([index, seed, text]) => {
            const shape = ALL_SHAPES[index] ?? HIGH_ENTROPY_SHAPE;
            return { ...shape.make(seed), text };
          });
          const input = samples.map(({ secret, text }) => `${text}\n${secret}\n`).join('');
          const out = scrubText(input);
          for (const { secret, core } of samples) {
            expect(out).not.toContain(secret);
            expect(out).not.toContain(core.slice(0, 16));
          }
          expect(out).toBe(samples.map(({ text }) => `${text}\n${M}\n`).join(''));
        },
      ),
      { seed: FC_SEED, numRuns: 100 },
    );
  });

  it('secrets in the string values of a structured value never survive scrubRaw', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.nat({ max: SECRET_SHAPES.length - 1 }),
        ordinaryTextArb,
        (seed, index, text) => {
          const shape = SECRET_SHAPES[index] ?? HIGH_ENTROPY_SHAPE;
          const { secret, core } = shape.make(seed);
          const value = {
            a: { b: [text, `${text} ${secret}`] },
            c: secret,
            tool_input: { command: `deploy --key ${secret}` },
            list: [secret],
          };
          const json = JSON.stringify(scrubRaw(value, BIG));
          expect(json).not.toContain(JSON.stringify(secret).slice(1, -1));
          expect(json).not.toContain(core);
        },
      ),
      { seed: FC_SEED, numRuns: 200 },
    );
  });
});

describe('property: long random tokens with no known prefix are redacted', () => {
  it.each([
    { name: 'lower-case alphanumeric token', make: lowerToken },
    { name: 'upper-case base32 token (A–Z, 2–7)', make: base32Token },
  ])('a 40–64 char $name, alone and embedded in ordinary text, is redacted', ({ make }) => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 40, max: 64 }),
        embeddingArb,
        (seed, length, embedding) => {
          const token = make(seed, length);
          expect(scrubText(token)).toBe(M);
          const { head, tail } = surround(embedding);
          const out = scrubText(`${head}${token}${tail}`);
          expect(out).not.toContain(token.slice(0, 16));
          expect(out).toBe(`${head}${M}${tail}`);
        },
      ),
      { seed: FC_SEED, numRuns: 200 },
    );
  });

  it('single-case tokens in scrubRaw string values never survive', () => {
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
      { seed: FC_SEED, numRuns: 200 },
    );
  });

  it.each([
    { name: 'letters only', alphabet: LETTERS },
    { name: 'base64 without digits (letters, + and /)', alphabet: `${LETTERS}+/` },
    { name: 'base64url without digits (letters, - and _)', alphabet: `${LETTERS}-_` },
  ])('a random 40–64 char token with no digit, $name, is redacted', ({ alphabet }) => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 40, max: 64 }), (seed, length) => {
        const token = digitFreeToken(seed, length, alphabet);
        expect(scrubText(token)).toBe(M);
        expect(scrubText(`session secret: ${token} (rotated)`)).toBe(
          `session secret: ${M} (rotated)`,
        );
      }),
      { seed: FC_SEED, numRuns: 200 },
    );
  });
});

describe('property: values under a secret-named key never survive scrubRaw', () => {
  it('any short value under a secret key becomes the marker', () => {
    const keys = ['API_KEY', 'DB_PASSWORD', 'password', 'apiKey', 'api_key', 'clientSecret'];
    fc.assert(
      fc.property(
        fc.constantFrom(...keys),
        fc.stringMatching(/^[a-z0-9][a-z0-9 ]{5,29}$/),
        (key, value) => {
          expect(scrubRaw({ outer: { [key]: value } }, BIG)).toEqual({ outer: { [key]: M } });
        },
      ),
      { seed: FC_SEED, numRuns: 100 },
    );
  });
});

describe('property: ordinary text comes back unchanged', () => {
  it('scrubText leaves generated ordinary text exactly as it was', () => {
    fc.assert(
      fc.property(ordinaryTextArb, (text) => {
        expect(scrubText(text)).toBe(text);
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it('scrubRaw leaves a structure of ordinary strings equal to its input when under the cap', () => {
    const valueArb = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: 'small' },
        ordinaryTextArb,
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie('node'), { maxLength: 4 }),
        fc.dictionary(fc.constantFrom('a', 'b', 'tool_input', 'content', 'cwd'), tie('node'), {
          maxKeys: 4,
        }),
      ),
    })).node;
    fc.assert(
      fc.property(valueArb, (value) => {
        expect(scrubRaw(value, BIG)).toEqual(value);
      }),
      { seed: FC_SEED, numRuns: 200 },
    );
  });

  it.each([
    { name: 'kebab-case names made of words', arb: kebabNameArb },
    { name: 'snake_case names made of words', arb: snakeNameArb },
    { name: 'upper-case constant names made of words', arb: constantNameArb },
  ])('long $name stay unchanged', ({ arb }) => {
    fc.assert(
      fc.property(arb, (name) => {
        expect(name.length).toBeGreaterThanOrEqual(40);
        expect(scrubText(name)).toBe(name);
      }),
      { seed: FC_SEED, numRuns: 300 },
    );
  });

  it('text mixing long names, hashes and ids with ordinary text stays unchanged', () => {
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
      { seed: FC_SEED, numRuns: 300 },
    );
  });

  it('word labels joined to a hex hash by - or _ stay unchanged', () => {
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

describe('property: the scrubbers never throw and are deterministic', () => {
  const scrubTextLoose = scrubText as unknown as (input: unknown) => unknown;

  it('scrubText never throws on any value and gives the same output twice', () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.string({ unit: 'binary' })), (value) => {
        const first = scrubTextLoose(value);
        const second = scrubTextLoose(value);
        expect(second).toEqual(first);
      }),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it('scrubRaw never throws on any value, serializes, and gives the same output twice', () => {
    fc.assert(
      fc.property(
        fc.anything({ withBigInt: true, withMap: true, withSet: true, withDate: true }),
        fc.integer({ min: 64, max: 4_096 }),
        (value, maxLength) => {
          const first = scrubRaw(value, { maxLength });
          const second = scrubRaw(value, { maxLength });
          expect(() => JSON.stringify(first)).not.toThrow();
          expect(second).toEqual(first);
        },
      ),
      { seed: FC_SEED, numRuns: 500 },
    );
  });

  it('scrubText output does not depend on what was scrubbed before', () => {
    const inputArb = fc.oneof(
      ordinaryTextArb,
      fc
        .tuple(fc.nat({ max: ALL_SHAPES.length - 1 }), fc.integer(), ordinaryTextArb)
        .map(
          ([index, seed, text]) =>
            `${text} ${(ALL_SHAPES[index] ?? HIGH_ENTROPY_SHAPE).make(seed).secret}`,
        ),
    );
    fc.assert(
      fc.property(fc.array(inputArb, { minLength: 1, maxLength: 8 }), (inputs) => {
        const forward = inputs.map((input) => scrubText(input));
        const backward = [...inputs]
          .reverse()
          .map((input) => scrubText(input))
          .reverse();
        expect(backward).toEqual(forward);
      }),
      { seed: FC_SEED, numRuns: 100 },
    );
  });
});
