// Task 1.4: how long each hook channel keeps the agent waiting, on this machine. No `claude` runs,
// so it spends no tokens.
//
//   npm run spike:latency [-- <runs>]      (default 30 runs each)
//
// - relay (command hook): the wall time of one `node relay.ts` run with a hook payload on stdin,
//   which is what a synchronous command hook blocks the agent for. Run directly (argv, as the
//   settings files register it) and through `cmd /c` on Windows (a shell or .cmd shim), with the
//   sink up and with it down (the fail-open path).
// - http (native HTTP hook): the time of one POST to the sink over loopback. Claude Code's own HTTP
//   client does the same work in-process, so this approximates its cost.
//
// Prints the median, p90 and max of each, in milliseconds.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { SINK_HOST } from './paths.ts';
import { startSink } from './sink.ts';

const RELAY = fileURLToPath(new URL('./relay.ts', import.meta.url));
const SCENARIO = 'latency';
// A realistic PreToolUse payload size (the captures' PreToolUse lines are about 1–2 KB).
const PAYLOAD = JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: 'src/math.js' },
  session_id: '00000000-0000-0000-0000-000000000000',
  padding: 'x'.repeat(1200),
});

function runOnce(
  file: string,
  args: string[],
  env: Record<string, string>,
  verbatim = false,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(file, args, {
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
      // cmd.exe parses its own command line: pass it exactly as written.
      windowsVerbatimArguments: verbatim,
    });
    child.on('error', reject);
    child.on('close', () => resolve(performance.now() - started));
    child.stdin.end(PAYLOAD);
  });
}

async function postOnce(url: string, token: string): Promise<number> {
  const started = performance.now();
  const res = await fetch(`${url}/hooks?scenario=${SCENARIO}&channel=http`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: PAYLOAD,
  });
  await res.arrayBuffer();
  return performance.now() - started;
}

function stats(ms: number[]): string {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return `median ${at(0.5).toFixed(1)} · p90 ${at(0.9).toFixed(1)} · max ${(sorted.at(-1) ?? 0).toFixed(1)} ms (n=${sorted.length})`;
}

async function repeat(n: number, once: () => Promise<number>): Promise<number[]> {
  const out: number[] = [];
  await once(); // warm the file cache once; not counted
  for (let i = 0; i < n; i++) out.push(await once());
  return out;
}

async function main(): Promise<number> {
  const runs = Number(process.argv[2] ?? '30');
  if (!Number.isInteger(runs) || runs < 1) {
    console.error('usage: npm run spike:latency [-- <runs>]');
    return 2;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'micro-minds-latency-'));
  const token = randomBytes(24).toString('base64url');
  // Every measured run must really reach the sink: a variant that fails fast (a quoting mistake)
  // would otherwise look fast.
  let captured = 0;
  const server = await startSink({
    port: 0,
    token,
    capturesDir: dir,
    log: () => undefined,
    onCapture: () => {
      captured++;
    },
  });
  const expectAll = (label: string, before: number) => {
    if (captured - before !== runs + 1) {
      throw new Error(`${label}: ${captured - before} of ${runs + 1} runs reached the sink`);
    }
  };
  const port = (server.address() as AddressInfo).port;
  const url = `http://${SINK_HOST}:${port}`;
  const env = {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    MICROMINDS_URL: url,
    MICROMINDS_HOOK_TOKEN: token,
  };
  const node = process.execPath;
  const results: [string, number[]][] = [];

  let before = captured;
  results.push(['http hook (loopback POST)', await repeat(runs, () => postOnce(url, token))]);
  expectAll('http', before);
  before = captured;
  results.push([
    'relay, node direct, sink up',
    await repeat(runs, () => runOnce(node, [RELAY, SCENARIO], env)),
  ]);
  expectAll('relay direct', before);
  if (process.platform === 'win32') {
    before = captured;
    const cmd = process.env.ComSpec ?? 'cmd.exe';
    results.push([
      'relay, via cmd /c, sink up',
      await repeat(runs, () =>
        runOnce(cmd, ['/d', '/s', '/c', `""${node}" "${RELAY}" ${SCENARIO}"`], env, true),
      ),
    ]);
    expectAll('relay via cmd', before);
  }
  await new Promise((resolve) => server.close(resolve));
  results.push([
    'relay, node direct, sink down',
    await repeat(runs, () => runOnce(node, [RELAY, SCENARIO], env)),
  ]);
  await rm(dir, { recursive: true, force: true });

  console.log(
    `Node ${process.version} on ${process.platform}; ${runs} runs each (after one warm-up run)`,
  );
  for (const [name, ms] of results) console.log(`${name.padEnd(32)} ${stats(ms)}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
