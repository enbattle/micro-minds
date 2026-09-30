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
