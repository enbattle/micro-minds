import { describe, expect, it } from 'vitest';
import { isProvider, PROVIDERS } from './provider.ts';

describe('isProvider', () => {
  it.each(PROVIDERS)('accepts %s', (provider) => {
    expect(isProvider(provider)).toBe(true);
  });

  it.each([['openai'], [''], ['CLAUDE'], [undefined], [null], [42]])('rejects %j', (value) => {
    expect(isProvider(value)).toBe(false);
  });
});
