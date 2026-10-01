// Task 2.6, clause C13: the logging conventions every later task follows. `createLogger` is the
// pino factory the server uses; tests give it an in-memory destination and read the JSON lines.
// Tokens are removed by redaction paths at every level, nested or not; payloads (`raw`,
// `payload`, `body`) appear only at debug.
import { describe, expect, it } from 'vitest';
import { logSink } from './logger.test-helpers.ts';
import { createLogger } from './logger.ts';

const SECRET = 'mm-secret-7Qx9ZtP2vL';
const PAYLOAD_MARK = 'mm-payload-4Hk8Wd';

type LevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const LEVELS: readonly LevelName[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function logAt(level: LevelName, value: object): string[] {
  const sink = logSink();
  const logger = createLogger({ level: 'trace', destination: sink });
  logger[level](value, 'a message');
  return sink.lines;
}

const TOKEN_SHAPES = [
  { name: 'the hook token', value: { hookToken: SECRET } },
  { name: 'the hook token, nested', value: { session: { hookToken: SECRET } } },
  { name: 'the hook token, nested twice', value: { ctx: { launch: { hookToken: SECRET } } } },
  {
    name: 'MICROMINDS_HOOK_TOKEN in a logged env',
    value: { env: { MICROMINDS_HOOK_TOKEN: SECRET } },
  },
  {
    name: 'MICROMINDS_HOOK_TOKEN in a nested env',
    value: { spawn: { env: { MICROMINDS_HOOK_TOKEN: SECRET, PATH: '/usr/bin' } } },
  },
  { name: 'an authorization header', value: { headers: { authorization: `Bearer ${SECRET}` } } },
  { name: 'an Authorization header', value: { headers: { Authorization: `Bearer ${SECRET}` } } },
  {
    name: 'an authorization header on a request',
    value: { req: { headers: { authorization: `Bearer ${SECRET}` } } },
  },
];

describe('createLogger (C13)', () => {
  describe.each(TOKEN_SHAPES)('redacts $name', ({ value }) => {
    it.each(LEVELS)('at %s', (level) => {
      const lines = logAt(level, value);

      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(SECRET);
      expect(lines[0]).toContain('a message');
    });
  });

  it('keeps ordinary fields next to a redacted one', () => {
    const lines = logAt('info', { sessionId: '01K6G5W0000000000000000001', hookToken: SECRET });

    const record: unknown = JSON.parse(lines[0] ?? '{}');
    expect(record).toMatchObject({ sessionId: '01K6G5W0000000000000000001', msg: 'a message' });
    expect(lines[0]).not.toContain(SECRET);
  });

  const PAYLOAD_SHAPES = [
    { name: 'raw', value: { raw: { tool_response: PAYLOAD_MARK } } },
    { name: 'payload', value: { payload: { prompt: PAYLOAD_MARK } } },
    { name: 'a hook body', value: { body: `{"x":"${PAYLOAD_MARK}"}` } },
    { name: "an event's raw", value: { event: { kind: 'unknown', raw: { x: PAYLOAD_MARK } } } },
  ];

  describe.each(PAYLOAD_SHAPES)('a payload ($name)', ({ value }) => {
    it.each(['info', 'warn', 'error', 'fatal'] as const)('is left out at %s', (level) => {
      const lines = logAt(level, value);

      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(PAYLOAD_MARK);
      expect(lines[0]).toContain('a message');
    });

    it('is logged at debug', () => {
      const lines = logAt('debug', value);

      expect(lines[0]).toContain(PAYLOAD_MARK);
    });
  });

  it('a child logger keeps both conventions (sessionId bound, payload dropped at info)', () => {
    const sink = logSink();
    const child = createLogger({ level: 'trace', destination: sink }).child({
      sessionId: '01K6G5W0000000000000000002',
    });

    child.info({ raw: { x: PAYLOAD_MARK }, hookToken: SECRET }, 'child line');

    expect(sink.lines).toHaveLength(1);
    expect(sink.records()[0]).toMatchObject({ sessionId: '01K6G5W0000000000000000002' });
    expect(sink.lines[0]).not.toContain(PAYLOAD_MARK);
    expect(sink.lines[0]).not.toContain(SECRET);
  });

  it('a payload logged at debug still has its tokens redacted', () => {
    const lines = logAt('debug', {
      payload: { headers: { authorization: `Bearer ${SECRET}` }, text: PAYLOAD_MARK },
      env: { MICROMINDS_HOOK_TOKEN: SECRET },
    });

    expect(lines[0]).toContain(PAYLOAD_MARK);
    expect(lines[0]).not.toContain(SECRET);
  });
});

// Task 2.7, clause C11: follow-up tests from the 2.6 review (docs/backlog.md). Payload keys are
// left out at info and above wherever they sit (arrays, child bindings, format arguments); token
// values are censored by key name at any depth and under any parent key; a shared (non-cyclic)
// object is logged in full each time; a logged Error keeps its type and message.
describe('createLogger follow-ups (2.7 C11)', () => {
  function capture(log: (logger: ReturnType<typeof createLogger>) => void) {
    const sink = logSink();
    const logger = createLogger({ level: 'trace', destination: sink });
    log(logger);
    return sink;
  }

  const PAYLOADS_ELSEWHERE: Array<{
    name: string;
    log: (logger: ReturnType<typeof createLogger>, level: LevelName) => void;
  }> = [
    {
      name: 'inside an array',
      log: (logger, level) =>
        logger[level]({ events: [{ raw: { x: PAYLOAD_MARK } }, { body: PAYLOAD_MARK }] }, 'm'),
    },
    {
      name: 'in a child-logger binding',
      log: (logger, level) => logger.child({ payload: { prompt: PAYLOAD_MARK } })[level]('m'),
    },
    {
      name: 'in an object format argument',
      log: (logger, level) => logger[level]('m %o', { raw: { x: PAYLOAD_MARK } }),
    },
  ];

  describe.each(PAYLOADS_ELSEWHERE)('a payload $name', ({ log }) => {
    it.each(['info', 'warn', 'error', 'fatal'] as const)('is left out at %s', (level) => {
      const sink = capture((logger) => log(logger, level));

      expect(sink.lines).toHaveLength(1);
      expect(sink.lines[0]).not.toContain(PAYLOAD_MARK);
    });
  });

  const TOKENS_ANYWHERE: Array<{
    name: string;
    log: (logger: ReturnType<typeof createLogger>, level: LevelName) => void;
  }> = [
    {
      name: 'MICROMINDS_HOOK_TOKEN under launchEnv',
      log: (logger, level) => logger[level]({ launchEnv: { MICROMINDS_HOOK_TOKEN: SECRET } }, 'm'),
    },
    {
      name: 'a top-level MICROMINDS_HOOK_TOKEN',
      log: (logger, level) => logger[level]({ MICROMINDS_HOOK_TOKEN: SECRET }, 'm'),
    },
    {
      name: 'a hookToken five levels deep',
      log: (logger, level) => logger[level]({ a: { b: { c: { d: { hookToken: SECRET } } } } }, 'm'),
    },
    {
      name: 'an authorization header under an unusual parent key',
      log: (logger, level) =>
        logger[level]({ upstream: { request: { authorization: `Bearer ${SECRET}` } } }, 'm'),
    },
    {
      name: 'a hookToken inside an array',
      log: (logger, level) => logger[level]({ launches: [{ ctx: { hookToken: SECRET } }] }, 'm'),
    },
    {
      name: 'a hookToken in a child-logger binding',
      log: (logger, level) => logger.child({ launch: { hookToken: SECRET } })[level]('m'),
    },
    {
      name: 'a hookToken in an object format argument',
      log: (logger, level) => logger[level]('m %o', { hookToken: SECRET }),
    },
  ];

  describe.each(TOKENS_ANYWHERE)('censors $name', ({ log }) => {
    it.each(['trace', 'error'] as const)('at %s', (level) => {
      const sink = capture((logger) => log(logger, level));

      expect(sink.lines).toHaveLength(1);
      expect(sink.lines[0]).not.toContain(SECRET);
    });
  });

  it('an object referenced twice (not a cycle) is logged twice in full, not as circular', () => {
    const shared = { name: 'shared-value' };
    const sink = capture((logger) =>
      logger.info({ first: shared, second: shared, list: [shared, shared] }, 'm'),
    );

    expect(sink.lines[0]).not.toContain('circular');
    expect(sink.records()[0]).toMatchObject({
      first: { name: 'shared-value' },
      second: { name: 'shared-value' },
      list: [{ name: 'shared-value' }, { name: 'shared-value' }],
    });
  });

  it.each([
    {
      name: 'under err',
      log: (logger: ReturnType<typeof createLogger>) =>
        logger.error({ err: new TypeError('bad type') }, 'failed'),
      type: 'TypeError',
      message: 'bad type',
    },
    {
      name: 'as the first argument',
      log: (logger: ReturnType<typeof createLogger>) =>
        logger.error(new RangeError('out of range')),
      type: 'RangeError',
      message: 'out of range',
    },
  ])('a logged Error keeps its type and message ($name)', ({ log, type, message }) => {
    const sink = capture(log);

    expect(sink.records()[0]).toMatchObject({ err: { type, message } });
  });
});
