// Phase 1 capture sink (task 1.1). Receives hook payloads from Claude Code's native HTTP hook and
// from the spike relay, and appends each one, raw, to
// ~/.micro-minds-dev/spike/captures/<scenario>.jsonl.
//
//   npm run spike:sink
//
// Loopback only (hard rule 3). Every request needs the bearer token printed at startup. The reply
// is always an empty 200, so a capture can never be read as a hook decision. Payloads are not
// logged to the console, and nothing here ever opens a payload's `transcript_path` (hard rule 1).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import process from 'node:process';
import { CAPTURES_DIR, captureFile, isChannel, isScenario, SINK_HOST, sinkPort } from './paths.ts';

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface SinkOptions {
  port: number;
  token: string;
  capturesDir: string;
  log?: (line: string) => void;
  /** Called after each capture is written, with only what a driver needs to react (drive.ts). */
  onCapture?: (event: CaptureEvent) => void;
}

export interface CaptureEvent {
  scenario: string;
  channel: string;
  hookEventName: string;
  toolName: string | undefined;
}

export interface CaptureRecord {
  receivedAt: number;
  channel: string;
  headerNames: string[];
  bodyBytes: number;
  body: unknown;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  // Hash both sides so the buffers have equal length for the constant-time compare.
  return timingSafeEqual(digest(presented), digest(token));
}

function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `${SINK_HOST}:${port}` || host === `localhost:${port}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseBody(bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function eventName(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'hook_event_name' in body) {
    const name = (body as { hook_event_name: unknown }).hook_event_name;
    if (typeof name === 'string') return name;
  }
  return '?';
}

export function startSink(options: SinkOptions): Promise<Server> {
  const log = options.log ?? ((line: string) => console.log(line));
  let port = options.port;
  // Appends are chained so concurrent hooks never interleave lines in a file.
  let writes: Promise<unknown> = Promise.resolve();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host, port)) throw new HttpError(403, 'bad host');
    const url = new URL(req.url ?? '/', `http://${SINK_HOST}:${port}`);
    if (url.pathname !== '/hooks') throw new HttpError(404, 'not found');
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    if (!tokenMatches(req.headers.authorization, options.token)) {
      throw new HttpError(401, 'bad token');
    }
    const scenario = url.searchParams.get('scenario');
    const channel = url.searchParams.get('channel');
    if (!isScenario(scenario)) throw new HttpError(400, 'bad scenario');
    if (!isChannel(channel)) throw new HttpError(400, 'bad channel');

    const bytes = await readBody(req);
    const record: CaptureRecord = {
      receivedAt: Date.now(),
      channel,
      headerNames: Object.keys(req.headers).sort(),
      bodyBytes: bytes.length,
      body: parseBody(bytes),
    };
    const file = captureFile(options.capturesDir, scenario);
    const write = writes.then(() => appendFile(file, `${JSON.stringify(record)}\n`, 'utf8'));
    writes = write.catch(() => undefined);
    await write;
    options.onCapture?.({
      scenario,
      channel,
      hookEventName: eventName(record.body),
      toolName: stringField(record.body, 'tool_name'),
    });

    log(
      `${new Date(record.receivedAt).toISOString()} ${scenario} ${channel} ${eventName(record.body)} ${bytes.length}B`,
    );
    res.writeHead(200).end();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      log(`rejected ${req.method ?? '?'} ${req.url ?? '?'}: ${status} ${message}`);
      if (!res.headersSent) res.writeHead(status, { connection: 'close' }).end();
      // Stop reading an oversized or rejected body.
      req.resume();
    });
  });

  return mkdir(options.capturesDir, { recursive: true }).then(
    () =>
      new Promise<Server>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, SINK_HOST, () => {
          server.off('error', reject);
          port = (server.address() as AddressInfo).port;
          resolve(server);
        });
      }),
  );
}

async function main(): Promise<void> {
  const port = sinkPort();
  const token = process.env.SPIKE_SINK_TOKEN || randomBytes(24).toString('base64url');
  try {
    await startSink({ port, token, capturesDir: CAPTURES_DIR });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === 'EADDRINUSE'
        ? `Port ${port} is taken. Stop the other process or set SPIKE_SINK_PORT.`
        : `Sink failed to start: ${String(error)}`,
    );
    process.exitCode = 1;
    return;
  }
  const url = `http://${SINK_HOST}:${port}`;
  console.log(`micro-minds spike sink listening on ${url}`);
  console.log(`Captures: ${CAPTURES_DIR}`);
  console.log('');
  console.log('Set these in the terminal where you run claude (from the scratch repo):');
  console.log(`  PowerShell: $env:MICROMINDS_URL='${url}'; $env:MICROMINDS_HOOK_TOKEN='${token}'`);
  console.log(`  bash:       export MICROMINDS_URL='${url}' MICROMINDS_HOOK_TOKEN='${token}'`);
  console.log('Then generate settings: npm run spike:settings -- <scenario> --channel http|relay');
  console.log('Ctrl-C to stop.');
}

if (import.meta.main) {
  await main();
}
