// Self-test for the Phase 1 capture path (task 1.1), without running claude:
//
//   npm run spike:relay-selftest
//
// Starts a sink on a random port with a temporary captures directory, then checks both channels
// and the fail-open and loopback rules. Exits 1 if any check fails. Never touches the real
// captures under ~/.micro-minds-dev.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureFile, SINK_HOST } from './paths.ts';
import { MAX_BODY_BYTES, startSink } from './sink.ts';

const RELAY = fileURLToPath(new URL('./relay.ts', import.meta.url));
const SAMPLE = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
const SCENARIO = 'selftest';
// Generous for a cold Node start on Windows; task 1.4 measures the real cost.
const RELAY_BUDGET_MS = 3000;

interface RelayRun {
  code: number | null;
  stdout: string;
  ms: number;
}

function runRelay(
  env: Record<string, string>,
  input: string,
  args = [SCENARIO],
): Promise<RelayRun> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [RELAY, ...args], {
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, ms: performance.now() - started }));
    child.stdin.end(input);
  });
}

function post(
  port: number,
  options: { path: string; token: string; host?: string; body: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: SINK_HOST,
        port,
        method: 'POST',
        path: options.path,
        headers: {
          host: options.host ?? `${SINK_HOST}:${port}`,
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    // The sink may close the connection mid-upload on a 413; the status has already arrived.
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') reject(error);
    });
    req.end(options.body);
  });
}

async function readCaptures(dir: string): Promise<{ channel: string; body: unknown }[]> {
  const text = await readFile(captureFile(dir, SCENARIO), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { channel: string; body: unknown });
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'micro-minds-spike-'));
  const token = randomBytes(24).toString('base64url');
  const server = await startSink({ port: 0, token, capturesDir: dir, log: () => undefined });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${SINK_HOST}:${port}`;
  const hooksPath = `/hooks?scenario=${SCENARIO}&channel=http`;
  const results: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, detail = '') => results.push([name, ok, detail]);

  try {
    const viaRelay = await runRelay({ MICROMINDS_URL: url, MICROMINDS_HOOK_TOKEN: token }, SAMPLE);
    check('relay: exits 0', viaRelay.code === 0, `code ${viaRelay.code}`);
    check('relay: stdout empty', viaRelay.stdout === '', JSON.stringify(viaRelay.stdout));
    check('relay: within budget', viaRelay.ms < RELAY_BUDGET_MS, `${viaRelay.ms.toFixed(0)} ms`);

    const httpStatus = await post(port, { path: hooksPath, token, body: SAMPLE });
    check('http: 200', httpStatus === 200, String(httpStatus));

    const lines = await readCaptures(dir);
    check(
      'captured: one relay line, one http line, bodies parsed',
      lines.length === 2 &&
        lines.some((l) => l.channel === 'relay') &&
        lines.some((l) => l.channel === 'http') &&
        lines.every((l) => JSON.stringify(l.body) === SAMPLE),
      `${lines.length} line(s)`,
    );

    const wrongToken = await post(port, { path: hooksPath, token: 'nope', body: SAMPLE });
    check('wrong token: 401', wrongToken === 401, String(wrongToken));
    const badScenario = await post(port, {
      path: '/hooks?scenario=..%2Fescape&channel=http',
      token,
      body: SAMPLE,
    });
    check('bad scenario: 400', badScenario === 400, String(badScenario));
    const badHost = await post(port, { path: hooksPath, token, host: 'evil.test', body: SAMPLE });
    check('non-loopback Host: 403', badHost === 403, String(badHost));
    const tooBig = await post(port, {
      path: hooksPath,
      token,
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });
    check('oversized body: 413', tooBig === 413, String(tooBig));
    check('rejected requests: nothing captured', (await readCaptures(dir)).length === 2);

    const noEnv = await runRelay({}, SAMPLE);
    check(
      'relay without env: exits 0, silent',
      noEnv.code === 0 && noEnv.stdout === '',
      `${noEnv.ms.toFixed(0)} ms`,
    );
    const remote = await runRelay(
      { MICROMINDS_URL: 'http://example.com:80', MICROMINDS_HOOK_TOKEN: token },
      SAMPLE,
    );
    check('relay to non-loopback URL: exits 0, silent', remote.code === 0 && remote.stdout === '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const down = await runRelay({ MICROMINDS_URL: url, MICROMINDS_HOOK_TOKEN: token }, SAMPLE);
  check(
    'relay with sink down: exits 0, silent, within budget',
    down.code === 0 && down.stdout === '' && down.ms < RELAY_BUDGET_MS,
    `${down.ms.toFixed(0)} ms`,
  );
  check('sink down: nothing captured', (await readCaptures(dir)).length === 2);

  await rm(dir, { recursive: true, force: true });

  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
