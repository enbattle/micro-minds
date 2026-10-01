// The logging conventions every server module follows (task 2.6):
// - pino, JSON lines. Session code logs through `logger.child({ sessionId })`, so every line about
//   a session carries its id.
// - Tokens never reach a log line: every logged object, format argument and child binding is
//   walked (objects and arrays, any depth) and the values of token keys (the hook token, the env
//   variables that hold it, authorization headers) are censored. pino's redaction paths do the
//   same for the common shapes, as a second layer.
// - Payloads (hook bodies, `raw`, `payload`) are logged only at debug and below: at info and
//   above they are left out, wherever they sit. Child bindings never carry them, at any level.
import pino, { type DestinationStream, type Level, type Logger } from 'pino';

export type { Logger };

export const CENSOR = '[redacted]';

/** Keys whose values are tokens, compared case-insensitively. */
const TOKEN_KEYS = new Set([
  'hooktoken',
  'microminds_hook_token',
  'otel_exporter_otlp_headers',
  'otel_exporter_otlp_metrics_headers',
  'authorization',
]);

/** The second layer: pino redaction paths for the common shapes. */
const TOKEN_PATHS = [
  'hookToken',
  'env.MICROMINDS_HOOK_TOKEN',
  'env.OTEL_EXPORTER_OTLP_HEADERS',
  'env.OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'headers.authorization',
  'headers.Authorization',
];
const NESTING = ['', '*.', '*.*.', '*.*.*.'];
export const REDACT_PATHS: readonly string[] = NESTING.flatMap((prefix) =>
  TOKEN_PATHS.map((p) => `${prefix}${p}`),
);

/** Keys that hold payloads: logged at debug only. */
const PAYLOAD_KEYS = new Set(['raw', 'payload', 'body']);

const DEBUG_LEVEL = pino.levels.values.debug ?? 20;

export interface LoggerOptions {
  level?: Level;
  /** Where lines go; stdout when omitted. */
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: options.level ?? 'info',
    redact: { paths: [...REDACT_PATHS], censor: CENSOR },
    hooks: {
      logMethod(args, method, level) {
        const dropPayloads = level > DEBUG_LEVEL;
        const cleaned = args.map((arg) => sanitize(arg, dropPayloads, new WeakSet()));
        method.apply(this, cleaned as typeof args);
      },
    },
  };
  const logger =
    options.destination === undefined ? pino(pinoOptions) : pino(pinoOptions, options.destination);
  // Child loggers inherit this through their prototype chain, so `this` is always the logger
  // `child` was called on and its own bindings are kept.
  const baseChild = logger.child;
  logger.child = function child(this: Logger, bindings, childOptions) {
    const clean = sanitize(bindings, true, new WeakSet());
    return baseChild.call(this, isRecord(clean) ? clean : {}, childOptions);
  } as Logger['child'];
  return logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A copy of `value` with token values censored and, when `dropPayloads`, payload keys left out,
 * at any depth through objects and arrays. Cycles are cut; strings and other primitives pass.
 */
function sanitize(value: unknown, dropPayloads: boolean, seen: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  // `seen` holds the current path only, so a shared (non-cyclic) object is copied each time.
  seen.add(value);
  try {
    return copy(value, dropPayloads, seen);
  } finally {
    seen.delete(value);
  }
}

function copy(value: object, dropPayloads: boolean, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, dropPayloads, seen));
  // An error's copy keeps its prototype, message and stack, so pino's err serializer still reads
  // it as an error of its own type; its own fields are cleaned like any object's.
  const out: Record<string, unknown> =
    value instanceof Error ? Object.create(Object.getPrototypeOf(value)) : {};
  if (value instanceof Error) {
    out.message = value.message;
    if (value.stack !== undefined) out.stack = value.stack;
  }
  for (const [key, child] of Object.entries(value)) {
    if (dropPayloads && PAYLOAD_KEYS.has(key)) continue;
    out[key] = TOKEN_KEYS.has(key.toLowerCase()) ? CENSOR : sanitize(child, dropPayloads, seen);
  }
  return out;
}
