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
  // Label-joined hex tokens, which the long-run pass takes for names (`worktree-<sha>`).
  new RegExp(`${START}pul-[a-f0-9]{40}(?![A-Za-z0-9])`, 'g'), // Pulumi
  new RegExp(`${START}bkua_[a-f0-9]{40}(?![A-Za-z0-9])`, 'g'), // Buildkite
  new RegExp(`${START}x(?:keysib|smtpsib)-[a-f0-9]{64}-[A-Za-z0-9]{16}(?![A-Za-z0-9])`, 'g'), // Brevo
  new RegExp(`${START}rubygems_[a-f0-9]{48}(?![A-Za-z0-9])`, 'g'), // RubyGems
  new RegExp(`${START}shippo_(?:live|test)_[a-f0-9]{40}(?![A-Za-z0-9])`, 'g'), // Shippo
  new RegExp(`${START}sgp_(?:[a-f0-9]{16}_)?[a-f0-9]{40}(?![A-Za-z0-9])`, 'g'), // Sourcegraph
  new RegExp(`${START}(?:live|test)_[a-f0-9]{35}(?![A-Za-z0-9])`, 'g'), // Lob
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

/**
 * `KEY=value` in the middle of a shell line (`cd app && API_KEY=…`, `env A=… B=…`, `-e K=…`): the
 * value runs to the next whitespace or shell operator, whatever it holds (`P@ss,w0rd!`).
 */
const SHELL_ASSIGNMENT = /(?<=^|[\s;&|])([A-Z][A-Z0-9_]*=)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|'"]+)/gm;

/** The key of a `KEY=value` right after an opening quote (`-e "K=…"`, `["K=…"]`). */
const QUOTED_KEY = /(?<=(["']))([A-Z][A-Z0-9_]*=)/g;

/**
 * A secret `KEY=value` right after an opening quote: the value runs to the matching closing
 * quote on the line, whatever it holds (`P@ss,w0rd!`, spaces, brackets). A non-secret key's value
 * isn't skipped, so a secret quoted inside it (`'DEBUG=1 … "API_KEY=…"'`) is still found. Each
 * character is scanned at most once past a secret key, so the pass stays linear.
 */
function scrubQuotedAssignments(text: string): string {
  let out = '';
  let from = 0;
  QUOTED_KEY.lastIndex = 0;
  for (let match = QUOTED_KEY.exec(text); match !== null; match = QUOTED_KEY.exec(text)) {
    const quote = match[1] ?? '"';
    const assign = match[2] ?? '';
    if (!secretKey(assign.slice(0, -1))) continue;
    const start = match.index + assign.length;
    let end = start;
    while (end < text.length) {
      const char = text.charAt(end);
      if (char === quote || char === '\n' || char === '\r') break;
      end++;
    }
    if (end > start) {
      out += `${text.slice(from, start)}${M}`;
      from = end;
    }
    QUOTED_KEY.lastIndex = end;
  }
  return out + text.slice(from);
}

/**
 * `KEY=value` inside brackets or a list (`(K=…)`, `A=1,K=…`, `env:K=…`, a literal `\n` escape):
 * here the value ends at the punctuation that closes its context. After a quote it only sees
 * what the quoted pass left: a value it already redacted starts with `[`, which this one can't
 * match.
 */
const NESTED_ASSIGNMENT =
  /(?<=["'=(,:[]|\\n)([A-Z][A-Z0-9_]*=)("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|'"()[\],\\]+)/gm;

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

/** Words before `KEY` that make it a data-structure key (`primaryKey`, `cacheKey`). */
const STRUCTURAL_KEY_WORDS = new Set([
  'PRIMARY',
  'FOREIGN',
  'SORT',
  'PARTITION',
  'CACHE',
  'RANGE',
  'IDEMPOTENCY',
  'UNIQUE',
  'COMPOSITE',
  'LOOKUP',
  'MAP',
  'GROUP',
  'ROW',
  'SHARD',
  'DEDUPE',
  'DEDUP',
  'INDEX',
  'OBJECT',
  'REACT',
  'ENTITY',
  'QUERY',
  // Keyboard modifiers (`ctrlKey`, `shiftKey`).
  'CTRL',
  'SHIFT',
  'ALT',
  'META',
]);

/** Words after `KEY` that describe the key, not its value (`keyPath`, `GPG_KEY_ID`). */
const KEY_DESCRIPTORS = new Set(['PATH', 'FILE', 'DIR', 'NAME', 'ID', 'INDEX', 'FIELD', 'COLUMN']);

/**
 * Words after a leading `KEY` that make it a keyboard or map term (`keyCode`, `keyDown`,
 * `keyMap`); after another word (`API_KEY_CODE`, `LICENSE_KEY_MAP`) they may name a secret.
 */
const LEADING_KEY_DESCRIPTORS = new Set([
  'CODE',
  'DOWN',
  'UP',
  'PRESS',
  'BINDING',
  'BINDINGS',
  'MAP',
  'FRAME',
  'FRAMES',
  'EVENT',
]);

/**
 * A word after any secret word that can't itself hold a secret (`tokenType`,
 * `PASSWORD_MIN_LENGTH`). Words that can (`SECRET_ID`, `DSN_URL`, `PASSWORD_PATH`) aren't here.
 */
const DESCRIPTORS = new Set([
  'TYPE',
  'TYPES',
  'COUNT',
  'LENGTH',
  'LEN',
  'MIN',
  'MAX',
  'LIMIT',
  'SIZE',
  'POLICY',
  'HINT',
  'FORMAT',
  'INDEX',
  'FIELD',
  'HEADER',
  'PARAM',
  'DIR',
  'THROUGH',
  'USAGE',
  'EXPIRY',
  'EXPIRES',
  'TTL',
]);

/**
 * A key naming a secret as one of its words, whatever the case style: `DB_PASSWORD`, `api-key`,
 * `apiKey`, `STRIPE_KEY`, an env-style `KEY`, `SECRET_KEY_BASE`, `VAULT_SECRET_ID` (not
 * `TOKENIZERS`, `keyboard`, `monkey`, a lower-case `key`, `primaryKey`, `keyPath`, `tokenType`,
 * `PASSWORD_MIN_LENGTH`).
 */
function secretKey(key: string): boolean {
  // PWD alone is the shell's working directory, not a password.
  if (key.toUpperCase() === 'PWD') return false;
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[-_\s.]+/)
    .filter((part) => part !== '');
  return parts.some((part, i) => {
    if (!SECRET_PARTS.has(part)) return false;
    const next = parts[i + 1];
    if (next !== undefined && DESCRIPTORS.has(next)) return false;
    if (part !== 'KEY') return true;
    // Alone, only the env-style upper-case `KEY` names a secret; a `key` is structure.
    if (parts.length === 1) return key === 'KEY';
    if (next !== undefined && KEY_DESCRIPTORS.has(next)) return false;
    if (i === 0 && next !== undefined && LEADING_KEY_DESCRIPTORS.has(next)) return false;
    return !STRUCTURAL_KEY_WORDS.has(parts[i - 1] ?? '');
  });
}

/** A value that is code, not a literal: a call, a lookup, a statement. */
function codeExpression(value: string): boolean {
  return /[()[\]{};]/.test(value) || /^(?:await|new)\s/.test(value);
}

const LITERAL = /^(?:None|null|undefined|nil|NULL|True|False|true|false)$/;
/**
 * A dotted name in code style: every segment is lower-case letters, `_` or `$` (`item.name`,
 * `config.db_password`). A digit or capital (`hunter2.x9Kq7Zp`) makes it a possible secret.
 */
const DOTTED_NAME = /^[a-z_$]+(?:\.[a-z_$]+)+$/;

/**
 * In a line that looks like source (indented, or spaces around `=`), a language literal or a
 * code-style dotted name (`token = None`, `key = item.name`) is code, not a secret value. A dotted
 * passphrase with capitals (`Correct.Horse.Battery`) is still a secret.
 */
function sourceValue(lead: string, eq: string, value: string): boolean {
  const sourceLike = lead !== '' || eq.trim() !== eq;
  return sourceLike && (LITERAL.test(value) || DOTTED_NAME.test(value));
}

function isQuoted(value: string): boolean {
  const first = value.charAt(0);
  return (first === '"' || first === "'") && value.length >= 2 && value.endsWith(first);
}

function redactValue(value: string): string {
  return isQuoted(value) ? `${value.charAt(0)}${M}${value.charAt(0)}` : M;
}

/** Runs long enough to be a random token: base64 and base64url characters. */
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

/**
 * A single-case run made of words, digit groups or hashes joined by `-`, `_` or `+`
 * (`micro-minds-server`, `MAXIMUM_CONCURRENT_SESSIONS`, `worktree-<sha>`, a `q=how+to+…` query);
 * a random single-case token isn't. Not `=`: `api_key=<hex>` in a query string is a secret.
 */
function singleCaseWords(run: string): boolean {
  const parts = run.split(/[-_+]+/).filter((part) => part !== '');
  // Names are joined from short parts (`k8s`, `python3`, `S3`, `2024`, `strengths`) or a hash;
  // a random token is one long unbroken part.
  return parts.length > 1 && parts.every((part) => part.length <= 16 || HEX_OR_UUID.test(part));
}

function highEntropy(run: string): boolean {
  if (HEX_OR_UUID.test(run)) return false;
  if (run.includes('/')) return !run.split('/').every(pathSegment);
  const upper = /[A-Z]/.test(run);
  const lower = /[a-z]/.test(run);
  if (!upper && !lower) return false;
  if (upper && lower) return !wordLike(run);
  // Single case: random tokens (lower-case alphanumeric, base32) mix in digits; a run of one
  // case with no digit is text (a word, filler, a repeated letter).
  return /\d/.test(run) && !singleCaseWords(run);
}

function bearerToken(token: string): boolean {
  // "the bearer of bad news" is prose; a token is long, or has digits.
  return token.length >= 8 && (/\d/.test(token) || token.length >= 20);
}

/** base64 and base64url characters: what a random token is made of. */
function tokenChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 43 || // +
    code === 47 || // /
    code === 61 || // =
    code === 95 || // _
    code === 45 // -
  );
}

/**
 * Replaces each high-entropy run of 40 or more token characters. A plain scan, not a regex: a
 * single multi-megabyte run would overflow the regex engine's stack.
 */
function scrubLongRuns(text: string): string {
  let out = '';
  let from = 0;
  let i = 0;
  while (i < text.length) {
    if (!tokenChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && tokenChar(text.charCodeAt(i))) i++;
    if (i - start >= 40 && highEntropy(text.slice(start, i))) {
      out += `${text.slice(from, start)}${M}`;
      from = i;
    }
  }
  return out + text.slice(from);
}

/** Replaces every secret in `text` with REDACTION_MARKER and keeps the text around it. */
export function scrubText(text: string): string {
  if (typeof text !== 'string') return text;
  try {
    return scrubTextPasses(text);
  } catch {
    // Fail closed: if a pass can't finish (an input past the engine's limits), nothing of the
    // text is kept rather than all of it.
    return M;
  }
}

function scrubTextPasses(text: string): string {
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
    if (!isQuoted(trimmed) && (codeExpression(trimmed) || sourceValue(lead, eq, trimmed))) {
      return whole;
    }
    return `${lead}${key}${eq}${redactValue(trimmed)}`;
  });
  out = out.replace(SHELL_ASSIGNMENT, (whole, assign: string, value: string) =>
    secretKey(assign.slice(0, -1)) ? `${assign}${redactValue(value)}` : whole,
  );
  // A quoted value is a string literal, never code, so all of it goes.
  out = scrubQuotedAssignments(out);
  out = out.replace(NESTED_ASSIGNMENT, (whole, assign: string, value: string) =>
    secretKey(assign.slice(0, -1)) && (isQuoted(value) || !codeExpression(value))
      ? `${assign}${redactValue(value)}`
      : whole,
  );
  return scrubLongRuns(out);
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

/**
 * A value under a secret-named key: strings, numbers and booleans become the marker, and so do
 * those inside an array; an object is scrubbed as usual (its own keys decide).
 */
function maskSecret(value: unknown, depth: number, seen: Set<object>): unknown {
  if (typeof value === 'string') return value === '' ? value : M;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return M;
  }
  if (Array.isArray(value)) {
    // The same depth and cycle guards as scrubValue: an array holding itself twice would
    // otherwise branch at every level.
    if (depth >= MAX_DEPTH) return '[too deep]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      return value.map((item) => {
        const masked = maskSecret(item, depth + 1, seen);
        return masked === undefined ? null : masked;
      });
    } finally {
      seen.delete(value);
    }
  }
  return scrubValue(value, depth, seen);
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
      // A value under a secret-named key (`password`, `apiKey`) is a secret whatever it looks
      // like: the structured form of a secret `KEY=value` line.
      const scrubbed = secretKey(key)
        ? maskSecret(item, depth + 1, seen)
        : scrubValue(item, depth + 1, seen);
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
 * extreme nesting) are replaced, so the result always serializes. Meant for JSON-parsed input:
 * an object reached along several paths (never the case after `JSON.parse`) is scrubbed once per
 * path.
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
