// Task 2.2, clauses 8–10: property-based tests for the scrubber with fast-check.
// Surface under test: REDACTION_MARKER, scrubText, scrubRaw (see scrub.test.ts).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REDACTION_MARKER, scrubRaw, scrubText } from './index.ts';
import {
  HIGH_ENTROPY_SHAPE,
  KNOWN_SHAPES,
  ordinaryTextArb,
  WRAPPERS,
} from './scrub.test-helpers.ts';

const M = REDACTION_MARKER;

const embeddingArb = fc.record({
  seed: fc.integer(),
  before: ordinaryTextArb,
  after: ordinaryTextArb,
  wrap: fc.constantFrom(...WRAPPERS),
  sepBefore: fc.constantFrom(' ', '\n'),
  sepAfter: fc.constantFrom(' ', '\n'),
});

describe('property: no generated secret survives scrubbing (clause 8)', () => {
  it.each([...KNOWN_SHAPES, HIGH_ENTROPY_SHAPE])(
    '$name, embedded anywhere in ordinary text, is replaced and nothing else changes',
    ({ make }) => {
      fc.assert(
        fc.property(embeddingArb, ({ seed, before, after, wrap, sepBefore, sepAfter }) => {
          const { secret, core } = make(seed);
          const head = `${before === '' ? '' : `${before}${sepBefore}`}${wrap[0]}`;
          const tail = `${wrap[1]}${after === '' ? '' : `${sepAfter}${after}`}`;
          const out = scrubText(`${head}${secret}${tail}`);
          expect(out).not.toContain(secret);
          expect(out).not.toContain(core.slice(0, 16));
          expect(out).toBe(`${head}${M}${tail}`);
        }),
        { numRuns: 100 },
      );
    },
  );

  it('several secrets of different shapes in one text: none survives', () => {
    const shapes = [...KNOWN_SHAPES, HIGH_ENTROPY_SHAPE];
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: shapes.length - 1 }), fc.integer(), ordinaryTextArb), {
          minLength: 2,
          maxLength: 6,
        }),
        (parts) => {
          const samples = parts.map(([index, seed, text]) => {
            const shape = shapes[index] ?? HIGH_ENTROPY_SHAPE;
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
      { numRuns: 100 },
    );
  });

  it('secrets in string values of a structured value never survive scrubRaw', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.nat({ max: KNOWN_SHAPES.length - 1 }),
        ordinaryTextArb,
        (seed, index, text) => {
          const shape = KNOWN_SHAPES[index] ?? HIGH_ENTROPY_SHAPE;
          const { secret, core } = shape.make(seed);
          const value = { a: { b: [text, `${text} ${secret}`] }, c: secret };
          const json = JSON.stringify(scrubRaw(value, { maxLength: 1_000_000 }));
          expect(json).not.toContain(JSON.stringify(secret).slice(1, -1));
          expect(json).not.toContain(core.slice(0, 16));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: ordinary text comes back unchanged (clause 9)', () => {
  it('scrubText leaves generated ordinary text exactly as it was', () => {
    fc.assert(
      fc.property(ordinaryTextArb, (text) => {
        expect(scrubText(text)).toBe(text);
      }),
      { numRuns: 500 },
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
        expect(scrubRaw(value, { maxLength: 1_000_000 })).toEqual(value);
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: the scrubbers never throw and are deterministic (clause 10)', () => {
  const scrubTextLoose = scrubText as unknown as (input: unknown) => unknown;

  it('scrubText never throws on any value and gives the same output twice', () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.string({ unit: 'binary' })), (value) => {
        const first = scrubTextLoose(value);
        const second = scrubTextLoose(value);
        expect(second).toEqual(first);
      }),
      { numRuns: 500 },
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
      { numRuns: 500 },
    );
  });

  it('scrubText output does not depend on what was scrubbed before', () => {
    const shapes = [...KNOWN_SHAPES, HIGH_ENTROPY_SHAPE];
    const inputArb = fc.oneof(
      ordinaryTextArb,
      fc
        .tuple(fc.nat({ max: shapes.length - 1 }), fc.integer(), ordinaryTextArb)
        .map(
          ([index, seed, text]) =>
            `${text} ${(shapes[index] ?? HIGH_ENTROPY_SHAPE).make(seed).secret}`,
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
      { numRuns: 100 },
    );
  });
});
