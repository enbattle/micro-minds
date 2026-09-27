import { describe, expect, it } from 'vitest';
import {
  describeModels,
  distinctModels,
  extractModels,
  parseClaudeVersion,
  UNKNOWN,
} from './versions.ts';

describe('parseClaudeVersion', () => {
  it.each([
    { stdout: '2.1.283 (Claude Code)\n', expected: '2.1.283' },
    { stdout: 'claude 3.0.0-beta.2', expected: '3.0.0-beta.2' },
    { stdout: '\r\n  10.20.30  \r\n', expected: '10.20.30' },
    { stdout: '', expected: UNKNOWN },
    { stdout: 'error: unknown option', expected: UNKNOWN },
    { stdout: 'v2.1', expected: UNKNOWN },
  ])('$stdout -> $expected', ({ stdout, expected }) => {
    expect(parseClaudeVersion(stdout)).toBe(expected);
  });
});

describe('extractModels', () => {
  it('lists modelUsage keys, costliest first', () => {
    const result = {
      type: 'result',
      modelUsage: {
        'claude-haiku-4-5': { costUSD: 0.002, inputTokens: 10, outputTokens: 5 },
        'claude-opus-5-5': { costUSD: 0.31, inputTokens: 900, outputTokens: 400 },
      },
    };
    expect(extractModels(result)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5']);
  });

  it('orders by name when cost is missing or equal', () => {
    const result = { modelUsage: { b: {}, a: { costUSD: 'x' }, c: { costUSD: 0 } } };
    expect(extractModels(result)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to a top-level model string', () => {
    expect(extractModels({ model: ' claude-sonnet-5 ' })).toEqual(['claude-sonnet-5']);
    expect(extractModels({ modelUsage: {}, model: 'm' })).toEqual(['m']);
  });

  it.each([
    { name: 'null', value: null },
    { name: 'an array', value: [] },
    { name: 'no fields', value: { type: 'result' } },
    { name: 'modelUsage not an object', value: { modelUsage: ['x'] } },
    { name: 'blank model', value: { model: '  ' } },
    { name: 'blank modelUsage key', value: { modelUsage: { ' ': {} } } },
  ])('returns nothing for $name', ({ value }) => {
    expect(extractModels(value)).toEqual([]);
  });
});

describe('distinctModels', () => {
  it('dedupes across trials in first-seen order and drops unknown', () => {
    expect(distinctModels([['a', 'b'], [UNKNOWN], ['b', 'c']])).toEqual(['a', 'b', 'c']);
  });

  it('is unknown when no trial named a model', () => {
    expect(distinctModels([])).toEqual([UNKNOWN]);
    expect(distinctModels([[], [UNKNOWN]])).toEqual([UNKNOWN]);
  });
});

describe('describeModels', () => {
  it.each([
    { models: ['a', 'b'], flag: undefined, expected: 'a, b' },
    { models: ['claude-opus-5-5'], flag: 'opus', expected: 'claude-opus-5-5 (--model opus)' },
    { models: [UNKNOWN], flag: undefined, expected: UNKNOWN },
    { models: [UNKNOWN], flag: 'opus', expected: 'unknown (--model opus)' },
  ])('$models + $flag', ({ models, flag, expected }) => {
    expect(describeModels(models, flag)).toBe(expected);
  });
});
