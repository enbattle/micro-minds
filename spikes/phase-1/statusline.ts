// Task 1.8: a status-line command that records what Claude Code passes it. drive.ts puts it in a
// scenario's --settings (`statusLine`), never in the user's settings. Each run appends the stdin
// JSON, raw, to ~/.micro-minds-dev/spike/captures/statusline-<scenario>.jsonl (outside the repo;
// it holds real paths), then prints one short line for the status bar.
//
//   node spikes/phase-1/statusline.ts <scenario>
//
// It always exits 0 and prints nothing but the status text, so it can't disturb the session.

import { appendFileSync, mkdirSync } from 'node:fs';
import process from 'node:process';
import { CAPTURES_DIR, captureFile, isScenario } from './paths.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const scenario = process.argv[2];
  const text = await readStdin();
  if (!isScenario(scenario)) return;
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // Keep the raw text: what arrived is the finding.
  }
  mkdirSync(CAPTURES_DIR, { recursive: true });
  appendFileSync(
    captureFile(CAPTURES_DIR, `statusline-${scenario}`),
    `${JSON.stringify({ receivedAt: Date.now(), body })}\n`,
    'utf8',
  );
  process.stdout.write('micro-minds spike status line');
}

try {
  await main();
} catch {
  // Never fail the status line.
}
process.exitCode = 0;
