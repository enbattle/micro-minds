// Generators for the 2.2-fix scrubber tests (scrub.fix.test.ts). Test-only.
//
// Like scrub.test-helpers.ts, every token is built at runtime from a seed, so the repo holds no
// token-shaped literal.
import fc from 'fast-check';
import { chars, DIGITS, HEX, LOWER, prng, UPPER } from './scrub.test-helpers.ts';

/** RFC 4648 base32 alphabet (TOTP seeds and similar): A–Z and 2–7. */
export const BASE32 = `${UPPER}234567`;
export const LOWER_ALNUM = `${LOWER}${DIGITS}`;

/** Lower-case letters that are not hex digits, so a token can never read as a hex hash. */
const LOWER_NOT_HEX = 'ghijklmnopqrstuvwxyz';
/** Upper-case letters that are not hex digits, so a token can never read as a hex hash. */
const UPPER_NOT_HEX = 'GHIJKLMNOPQRSTUVWXYZ';

/**
 * A random lower-case alphanumeric token of `length` characters. It holds at least one letter
 * outside a–f and at least one digit, then random characters from a–z and 0–9.
 */
export function lowerToken(seed: number, length: number): string {
  const next = prng(seed);
  return (
    chars(next, 1, LOWER_NOT_HEX) + chars(next, 1, DIGITS) + chars(next, length - 2, LOWER_ALNUM)
  );
}

/**
 * A random upper-case base32 token of `length` characters (A–Z, 2–7). It holds at least one letter
 * outside A–F and at least one digit, then random base32 characters.
 */
export function base32Token(seed: number, length: number): string {
  const next = prng(seed);
  return chars(next, 1, UPPER_NOT_HEX) + chars(next, 1, '234567') + chars(next, length - 2, BASE32);
}

/** A random lower-case hex string (a SHA-1 or SHA-256 hash when 40 or 64 long). */
export function hexString(seed: number, length: number): string {
  return chars(prng(seed), length, HEX);
}

/**
 * Ordinary English words found in identifiers. None names a secret (no key, token, secret, pass,
 * password, pwd, credential, dsn), so a name built from them is never a secret-named key.
 */
export const NAME_WORDS = [
  'micro',
  'minds',
  'server',
  'core',
  'integration',
  'tests',
  'runner',
  'agent',
  'agents',
  'session',
  'sessions',
  'worktree',
  'reducer',
  'health',
  'mood',
  'idle',
  'working',
  'status',
  'board',
  'terminal',
  'provider',
  'adapter',
  'fixture',
  'replay',
  'snapshot',
  'event',
  'events',
  'hook',
  'relay',
  'config',
  'loader',
  'parser',
  'schema',
  'render',
  'scene',
  'character',
  'update',
  'handler',
  'manager',
  'builder',
  'factory',
  'helper',
  'module',
  'package',
  'shared',
  'client',
  'request',
  'response',
  'timeout',
  'retry',
  'queue',
  'worker',
  'cache',
  'store',
  'layout',
  'panel',
  'button',
  'dialog',
  'window',
  'theme',
  'color',
  'label',
  'title',
  'header',
  'footer',
  'content',
  'message',
  'history',
  'search',
  'filter',
  'sorted',
  'result',
  'output',
  'input',
  'format',
  'string',
  'number',
  'value',
  'record',
  'entry',
  'maximum',
  'minimum',
  'concurrent',
  'workspace',
  'default',
  'enabled',
  'per',
  'for',
  'the',
  'and',
  'max',
  'new',
  'to',
  'of',
] as const;

/** Words joined by `sep` until the name is at least `minLength` characters long. */
function joinWords(words: readonly string[], sep: string, minLength: number): string {
  let name = '';
  for (const word of words) {
    name = name === '' ? word : `${name}${sep}${word}`;
    if (name.length >= minLength) break;
  }
  return name;
}

const wordsArb = fc.array(fc.constantFrom(...NAME_WORDS), { minLength: 24, maxLength: 24 });

/** A long lower-case kebab-case name made of words, 40 characters or more. */
export const kebabNameArb: fc.Arbitrary<string> = wordsArb.map((words) =>
  joinWords(words, '-', 40),
);

/** A long lower-case snake_case name made of words, 40 characters or more. */
export const snakeNameArb: fc.Arbitrary<string> = wordsArb.map((words) =>
  joinWords(words, '_', 40),
);

/** A long upper-case constant name made of words joined by `_`, 40 characters or more. */
export const constantNameArb: fc.Arbitrary<string> = wordsArb.map((words) =>
  joinWords(words, '_', 40).toUpperCase(),
);
