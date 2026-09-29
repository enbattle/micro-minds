// The fake CLI (task 2.4): what a session runs in its PTY when the provider is `fake`.
//
//   node cli.ts [--scenario <name>] [-- <first prompt>]
//
// It echoes every stdin line to stdout. For the first prompt and for each stdin line other than
// `/exit`, it replays fixtures/fake/<scenario>.jsonl (default `basic`) to the session's /hooks,
// one POST per line, in order, with the hook token from its env. Like a real CLI's hooks it fails
// open: a refused, failed or slow POST is skipped, and a missing env or scenario only disables the
// replay. `/exit` or the end of stdin ends it with exit code 0.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { type FakeCliEnv, readFakeCliEnv } from '../../config/fake-cli.ts';
import { hookEndpoint } from '../hook-url.ts';

const SCENARIO_DIR = path.resolve(import.meta.dirname, '../../../../../fixtures/fake');
const SCENARIO_NAME = /^[a-z0-9-]+$/;
/** Like a real hook's timeout: a hung server never stalls the replay. */
const POST_TIMEOUT_MS = 1000;

/** The scenario's lines as JSON bodies, or none if the name is invalid or the file is missing. */
function loadScenario(name: string): string[] {
  if (!SCENARIO_NAME.test(name)) return [];
  try {
    return readFileSync(path.join(SCENARIO_DIR, `${name}.jsonl`), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

async function post(target: FakeCliEnv, body: string): Promise<void> {
  try {
    const response = await fetch(hookEndpoint(target.url, target.sessionId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    // Fail open, as hooks do.
  }
}

function main(): void {
  let values: { scenario?: string | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: { scenario: { type: 'string' } },
    }));
  } catch {
    values = {};
    positionals = [];
  }
  const target = readFakeCliEnv();
  const scenario = loadScenario(values.scenario ?? 'basic');

  // Replays run one after another, in the order their prompts arrived.
  let queue: Promise<void> = Promise.resolve();
  const replay = (): void => {
    if (target === undefined) return;
    queue = queue.then(async () => {
      for (const body of scenario) await post(target, body);
    });
  };

  const firstPrompt = positionals[0];
  if (firstPrompt !== undefined) replay();

  const finish = (): void => {
    void queue.then(() => process.exit(0));
  };
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', (line) => {
    process.stdout.write(`${line}\n`);
    if (line === '/exit') {
      input.close();
      return;
    }
    replay();
  });
  input.on('close', finish);
}

main();
