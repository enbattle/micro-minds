// Phase 1 spike relay (task 1.1): the command-hook path into the capture sink, so task 1.4 can
// compare it with the native HTTP hook. Throwaway; the production relay is packages/hook-relay
// (not used for Claude: task 1.4 chose native HTTP hooks, ADR 0029).
//
//   node spikes/phase-1/relay.ts <scenario>     (run by Claude Code as a command hook)
//
// Fails open (hard rule 5, ADR 0009): it always exits 0, never writes to stdout, gives the POST a
// 500 ms timeout, and exits at once when MICROMINDS_URL or MICROMINDS_HOOK_TOKEN is missing or the
// URL isn't loopback.

import process from 'node:process';
import { isScenario } from './paths.ts';

const POST_TIMEOUT_MS = 500;
// Hard ceiling for the whole run, in case stdin is never closed.
const DEADLINE_MS = 1500;

function loopbackBase(raw: string | undefined): URL | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    return url.protocol === 'http:' && loopback ? url : undefined;
  } catch {
    return undefined;
  }
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

async function relay(): Promise<void> {
  const base = loopbackBase(process.env.MICROMINDS_URL);
  const token = process.env.MICROMINDS_HOOK_TOKEN;
  const scenario = process.argv[2];
  if (base === undefined || !token || !isScenario(scenario)) return;

  setTimeout(() => process.exit(0), DEADLINE_MS).unref();
  const body = await readStdin();
  const target = new URL('/hooks', base);
  target.searchParams.set('scenario', scenario);
  target.searchParams.set('channel', 'relay');
  await fetch(target, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
}

process.exitCode = 0;
try {
  await relay();
} catch {
  // Fail open: a down sink, a timeout or a bad payload must never affect the agent.
}
process.exitCode = 0;
