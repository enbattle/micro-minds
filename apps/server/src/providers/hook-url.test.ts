// Task 2.4, clause D1: the one hook endpoint both adapters post to.
import { describe, expect, it } from 'vitest';
import { hookEndpoint } from './hook-url.ts';

const SESSION = '01K6A2B3C4D5E6F7G8H9J0K1M2';

describe('hookEndpoint', () => {
  it.each([
    {
      name: 'no trailing slash',
      serverUrl: 'http://127.0.0.1:4317',
      expected: `http://127.0.0.1:4317/hooks?session=${SESSION}`,
    },
    {
      name: 'a trailing slash is not doubled',
      serverUrl: 'http://127.0.0.1:4317/',
      expected: `http://127.0.0.1:4317/hooks?session=${SESSION}`,
    },
    {
      name: 'another port',
      serverUrl: 'http://127.0.0.1:50123',
      expected: `http://127.0.0.1:50123/hooks?session=${SESSION}`,
    },
  ])('$name → $expected', ({ serverUrl, expected }) => {
    expect(hookEndpoint(serverUrl, SESSION)).toBe(expected);
  });

  it("'http://127.0.0.1:4317/' and 'http://127.0.0.1:4317' give the same endpoint", () => {
    expect(hookEndpoint('http://127.0.0.1:4317/', SESSION)).toBe(
      hookEndpoint('http://127.0.0.1:4317', SESSION),
    );
  });

  it.each([
    { name: 'ampersand and equals', sessionId: 'a&b=c' },
    { name: 'slash and question mark', sessionId: 'x/y?z' },
    { name: 'hash and percent', sessionId: 'p#q%r' },
    { name: 'space and plus', sessionId: 'a b+c' },
  ])('URL-encodes the session id ($name) so it round-trips', ({ sessionId }) => {
    const endpoint = hookEndpoint('http://127.0.0.1:4317', sessionId);
    const url = new URL(endpoint);
    expect(url.pathname).toBe('/hooks');
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['session']);
    expect(url.searchParams.get('session')).toBe(sessionId);
    expect(endpoint.startsWith('http://127.0.0.1:4317/hooks?session=')).toBe(true);
  });
});
