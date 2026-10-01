// Task 2.6: an in-memory pino destination for tests. It collects every JSON line the logger
// writes, so a test can assert what was (and wasn't) logged.

export interface LogSink {
  write(msg: string): void;
  readonly lines: string[];
  /** Every line parsed as a JSON object. */
  records(): Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function logSink(): LogSink {
  const lines: string[] = [];
  return {
    lines,
    write(msg: string) {
      for (const line of msg.split('\n')) if (line.trim() !== '') lines.push(line);
    },
    records() {
      return lines.map((line) => {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error(`log line is not a JSON object: ${line}`);
        return parsed;
      });
    },
  };
}
