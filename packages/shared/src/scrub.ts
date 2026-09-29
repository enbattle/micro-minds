// The scrubber (PLAN §9 item 5, D14): `tool.summary`, `text` and the stored `raw` pass through it
// before they are stored or shown. Pure and deterministic; it never throws, and every pass is
// linear in the input, because hook payloads carry tool output from possibly hostile repos and the
// server is single-threaded. Heuristic by nature (the threat model accepts that), so its corpus of
// secret shapes and negatives is tested.

/** What replaces each secret. */
export const REDACTION_MARKER = '[REDACTED]';

const M = REDACTION_MARKER;

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,64}PRIVATE KEY-----/g;

/**
 * Private key blocks, whatever the line endings. A scan instead of one lazy regex: once no END
 * marker is left, no later BEGIN can close either, so it stops instead of rescanning.
 */
function scrubPem(text: string): string {
  let out = '';
  let from = 0;
  PEM_BEGIN.lastIndex = 0;
  for (;;) {
    PEM_BEGIN.lastIndex = from;
    const begin = PEM_BEGIN.exec(text);
    if (begin === null) break;
    PEM_END.lastIndex = begin.index + begin[0].length;
    const end = PEM_END.exec(text);
    if (end === null) break;
    out += `${text.slice(from, begin.index)}${M}`;
    from = end.index + end[0].length;
  }
  return out + text.slice(from);
}

/**
 * Keys with a known prefix, and JWTs. A match may only start where a token starts (not inside a
 * run of token characters), so a flood of prefixes can't restart the match at every position.
 */
const START = '(?<![A-Za-z0-9_-])';
const KNOWN = [
  new RegExp(`${START}sk-[A-Za-z0-9_-]{20,}`, 'g'), // Anthropic (sk-ant-…), OpenAI (sk-…, sk-proj-…)
  new RegExp(`${START}[rs]k_(?:live|test)_[A-Za-z0-9]{20,}`, 'g'), // Stripe
  new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{30,}`, 'g'), // GitHub tokens
  new RegExp(`${START}github_pat_[A-Za-z0-9_]{50,}`, 'g'), // GitHub fine-grained tokens
  new RegExp(`${START}glpat-[A-Za-z0-9_-]{20,}`, 'g'), // GitLab personal access tokens
  new RegExp(`${START}hf_[A-Za-z0-9]{30,}`, 'g'), // Hugging Face
  new RegExp(`${START}npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])`, 'g'), // npm
  new RegExp(`${START}do[opr]_v1_[a-f0-9]{64}(?![A-Za-z0-9])`, 'g'), // DigitalOcean
  new RegExp(`${START}SK[0-9a-fA-F]{32}(?![A-Za-z0-9])`, 'g'), // Twilio API keys
  new RegExp(`${START}(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])`, 'g'), // AWS access key ids
  new RegExp(`${START}AIza[A-Za-z0-9_-]{35}`, 'g'), // Google API keys
  new RegExp(`${START}xox[abeoprs]-[A-Za-z0-9-]{10,}`, 'g'), // Slack
  new RegExp(`${START}eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{10,}`, 'g'), // JWT
];

/** `scheme://user:password@host`: the password goes, the user and host stay. */
const URL_USERINFO =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/"'<>]{0,256}:)([^\s@/"'<>]{1,256})(@)/gi;

/** `Authorization: Basic …` / `Authorization: token …` (a header, or a JSON headers object). */
const AUTH_HEADER =
  /(authorization["']?[ \t]*[:=][ \t]*["']?(?:basic|token)[ \t]+)([A-Za-z0-9+/=._~-]+)/gi;

/** `Bearer <token>` (RFC 6750 token characters); the scheme word is kept. */
const BEARER = /\b(bearer)([ \t]+)([A-Za-z0-9\-._~+/]+=*)/gi;

/** `--password=…`, `--api-key=…` and similar command-line flags. */
const SECRET_FLAG =
  /(?<![A-Za-z0-9-])(--?[A-Za-z][A-Za-z0-9-]*=)("[^"\r\n]*"|'[^'\r\n]*'|[^\s'"]+)/g;

/** Flag-name parts that name a secret (`--password`, `--api-key`, `--db-pass`). */
const SECRET_FLAG_PARTS = new Set(['password', 'passwd', 'pass', 'pwd', 'token', 'secret', 'key']);

function secretFlag(flag: string): boolean {
  return flag
    .replace(/^-+/, '')
    .slice(0, -1)
    .toLowerCase()
    .split('-')
    .some((part) => SECRET_FLAG_PARTS.has(part));
}

/** A `KEY=value` line of env-like content: the value runs to the end of the line. */
const ENV_LINE = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/gm;

/** `KEY=value` in the middle of a shell line (`cd app && API_KEY=…`, `env A=… B=…`, `-e K=…`). */
const SHELL_ASSIGNMENT = /(?<=^|[\s;&|])([A-Z][A-Z0-9_]*=)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|'"]+)/gm;

/** `_`-separated key parts that name a secret (`DB_PASS`, `SENTRY_DSN`; not `TOKENIZERS`). */
const SECRET_PARTS = new Set([
  'KEY',
  'APIKEY',
  'TOKEN',
  'SECRET',
  'PASS',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'PWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'DSN',
]);

function secretKey(key: string): boolean {
  const upper = key.toUpperCase();
  // PWD alone is the shell's working directory, not a password.
  if (upper === 'PWD') return false;
  return upper.split('_').some((part) => SECRET_PARTS.has(part));
}

/** A value that is code, not a literal: a call, a lookup, a statement. */
function codeExpression(value: string): boolean {
  return /[()[\]{};]/.test(value) || /^(?:await|new)\s/.test(value);
}

function isQuoted(value: string): boolean {
  const first = value.charAt(0);
  return (first === '"' || first === "'") && value.length >= 2 && value.endsWith(first);
}

function redactValue(value: string): string {
  return isQuoted(value) ? `${value.charAt(0)}${M}${value.charAt(0)}` : M;
}

/** Runs long enough to be a random token: base64 and base64url characters. */
const LONG_RUN = /[A-Za-z0-9+/=_-]{40,}/g;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX_OR_UUID = /^[0-9A-Fa-f-]+$/;
const TOKEN_PARTS = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+|[^A-Za-z0-9]+/g;
const WORD = /^[A-Z]?[a-z]{2,}$/;
const VOWEL = /[aeiouy]/i;
const CONSONANT_RUN = /[^aeiouy]{5}/i;

/** A capitalized or lower-case word of three letters or more that can be pronounced. */
function isWord(part: string): boolean {
  return WORD.test(part) && VOWEL.test(part) && !CONSONANT_RUN.test(part);
}

/**
 * Made of words: most letters sit in pronounceable words (`handleOAuth2Callback`,
 * `node_modules`, `Release2Notes`). Random tokens rarely are: their "words" (`Vgzhw`, `Pbpdc`)
 * lack vowels or pile up consonants.
 */
function wordLike(text: string): boolean {
  let letters = 0;
  let inWords = 0;
  for (const part of text.match(TOKEN_PARTS) ?? []) {
    const count = part.replace(/[^A-Za-z]/g, '').length;
    letters += count;
    if (isWord(part)) inWords += count;
  }
  return letters === 0 || inWords >= 0.8 * letters;
}

/** A path segment of words or ids (`node_modules`, a ULID, a hash, a `%20` leftover like `E6`). */
function pathSegment(segment: string): boolean {
  return (
    segment.length <= 4 ||
    ULID.test(segment) ||
    HEX_OR_UUID.test(segment) ||
    /^[A-Z0-9_-]{1,12}$/.test(segment) ||
    // File and directory names (`npm-cli`, `node_modules`); a random token's segments almost
    // always hold an upper-case letter.
    /^[a-z0-9_-]+$/.test(segment) ||
    wordLike(segment)
  );
}

function highEntropy(run: string): boolean {
  if (!/[A-Z]/.test(run) || !/[a-z]/.test(run)) return false;
  if (HEX_OR_UUID.test(run)) return false;
  if (run.includes('/')) return !run.split('/').every(pathSegment);
  return !wordLike(run);
}

function bearerToken(token: string): boolean {
  // "the bearer of bad news" is prose; a token is long, or has digits.
  return token.length >= 8 && (/\d/.test(token) || token.length >= 20);
}

/** Replaces every secret in `text` with REDACTION_MARKER and keeps the text around it. */
export function scrubText(text: string): string {
  if (typeof text !== 'string') return text;
  let out = scrubPem(text);
  for (const pattern of KNOWN) out = out.replace(pattern, M);
  out = out.replace(
    URL_USERINFO,
    (_whole, head: string, _pw: string, at: string) => `${head}${M}${at}`,
  );
  out = out.replace(AUTH_HEADER, (_whole, head: string) => `${head}${M}`);
  out = out.replace(BEARER, (whole, scheme: string, space: string, token: string) =>
    bearerToken(token) ? `${scheme}${space}${M}` : whole,
  );
  out = out.replace(SECRET_FLAG, (whole, flag: string, value: string) =>
    secretFlag(flag) ? `${flag}${redactValue(value)}` : whole,
  );
  out = out.replace(ENV_LINE, (whole, lead: string, key: string, eq: string, value: string) => {
    const trimmed = value.trim();
    if (!secretKey(key) || trimmed === '') return whole;
    if (!isQuoted(trimmed) && codeExpression(trimmed)) return whole;
    return `${lead}${key}${eq}${redactValue(trimmed)}`;
  });
  out = out.replace(SHELL_ASSIGNMENT, (whole, assign: string, value: string) =>
    secretKey(assign.slice(0, -1)) && (isQuoted(value) || !codeExpression(value))
      ? `${assign}${redactValue(value)}`
      : whole,
  );
  return out.replace(LONG_RUN, (run) => (highEntropy(run) ? M : run));
}

export interface ScrubRawOptions {
  /**
   * The largest `JSON.stringify` length of the result; larger values are truncated. A cap too
   * small for `{"truncated":true}` (18 characters) still returns that object. NaN or a negative
   * cap counts as 0; Infinity keeps everything.
   */
  maxLength: number;
}

/** Nested values deeper than this are cut: nothing legitimate in a hook payload nests so deep. */
const MAX_DEPTH = 64;

/** Sets an own data property, so a `__proto__` key stays a key instead of setting a prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function scrubValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return undefined; // undefined, functions, symbols
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const scrubbed = scrubValue(item, depth + 1, seen);
        return scrubbed === undefined ? null : scrubbed;
      });
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const scrubbed = scrubValue(item, depth + 1, seen);
      if (scrubbed !== undefined) setOwn(out, scrubText(key), scrubbed);
    }
    return out;
  } catch {
    return '[unreadable]';
  } finally {
    seen.delete(value);
  }
}

function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** The start of an over-long value, as `{ truncated: true, preview }` within `maxLength`. */
function truncate(json: string, maxLength: number): unknown {
  let length = maxLength;
  // Each step removes at least the overshoot, so a handful of steps is always enough.
  for (let step = 0; step < 64 && length > 0; step++) {
    const candidate = { truncated: true, preview: json.slice(0, length) };
    const size = serialize(candidate)?.length ?? Number.POSITIVE_INFINITY;
    if (size <= maxLength) return candidate;
    length = Math.max(0, length - Math.max(1, size - maxLength));
  }
  return { truncated: true };
}

/**
 * Scrubs every string inside a JSON-like value (for the stored `raw`, D14), keys included,
 * without mutating it, then caps its serialized size. Unserializable parts (cycles, functions,
 * extreme nesting) are replaced, so the result always serializes.
 */
export function scrubRaw(value: unknown, options: ScrubRawOptions): unknown {
  const requested = options.maxLength;
  const maxLength =
    requested === Number.POSITIVE_INFINITY
      ? requested
      : Number.isFinite(requested) && requested > 0
        ? Math.floor(requested)
        : 0;
  const scrubbed = scrubValue(value, 0, new Set());
  const json = serialize(scrubbed);
  if (json === undefined || json.length <= maxLength) return scrubbed;
  return truncate(json, maxLength);
}
