// ULIDs (CLAUDE.md "IDs: ULID"): 48 bits of ms time, then 80 random bits, in Crockford base32.
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newUlid(now: number = Date.now()): string {
  let time = '';
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < 10; i += 1) {
    time = `${CROCKFORD[t % 32] ?? '0'}${time}`;
    t = Math.floor(t / 32);
  }
  let random = '';
  // 16 characters of 5 bits each, one random byte per character (the top 3 bits dropped).
  for (const byte of randomBytes(16)) random += CROCKFORD[byte % 32] ?? '0';
  return `${time}${random}`;
}
