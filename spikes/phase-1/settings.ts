// Phase 1 settings generator (task 1.1). Writes a per-scenario Claude Code settings file that sends
// every hook event to the capture sink, over one channel, and prints the command to run.
//
//   npm run spike:settings -- <scenario> --channel http|relay [--literal-token]
//
// The file goes to ~/.micro-minds-dev/spike/settings/ and is passed with `claude --settings`; the
// user's own ~/.claude/settings.json is never touched (hard rule 2). It holds hooks only: no
// permissions and no env (threat model, "injected settings"). By default the token is not in the
// file: the http hook reads it from MICROMINDS_HOOK_TOKEN through `allowedEnvVars`, and the relay
// reads it from its environment. Whether that interpolation works is verified in task 1.3;
// `--literal-token` writes the token itself as a fallback.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type Channel, isChannel, isScenario, SETTINGS_DIR, SINK_HOST, sinkPort } from './paths.ts';

// PLAN §5.3, plus the events whose mapping Phase 1 has to confirm.
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
] as const;

const TOKEN_ENV = 'MICROMINDS_HOOK_TOKEN';
const HOOK_TIMEOUT_SECONDS = 5;
const RELAY_PATH = fileURLToPath(new URL('./relay.ts', import.meta.url));

export interface SettingsInput {
  scenario: string;
  channel: Channel;
  port: number;
  literalToken?: string;
}

function hookFor(input: SettingsInput): Record<string, unknown> {
  if (input.channel === 'relay') {
    return {
      type: 'command',
      command: 'node',
      args: [RELAY_PATH, input.scenario],
      timeout: HOOK_TIMEOUT_SECONDS,
    };
  }
  const url = new URL('/hooks', `http://${SINK_HOST}:${input.port}`);
  url.searchParams.set('scenario', input.scenario);
  url.searchParams.set('channel', 'http');
  const token = input.literalToken ?? `$${TOKEN_ENV}`;
  return {
    type: 'http',
    url: url.toString(),
    headers: { Authorization: `Bearer ${token}` },
    ...(input.literalToken === undefined ? { allowedEnvVars: [TOKEN_ENV] } : {}),
    timeout: HOOK_TIMEOUT_SECONDS,
  };
}

export function buildSettings(input: SettingsInput): Record<string, unknown> {
  const hook = hookFor(input);
  const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [hook] }]]));
  return { hooks };
}

function usage(message: string): never {
  console.error(message);
  console.error(
    'Usage: npm run spike:settings -- <scenario> --channel http|relay [--literal-token]',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      channel: { type: 'string' },
      'literal-token': { type: 'boolean', default: false },
    },
  });
  const scenario = positionals[0];
  if (!isScenario(scenario)) {
    usage('The scenario must be lowercase letters, digits and dashes (for example a-qa).');
  }
  if (!isChannel(values.channel)) usage('--channel must be http or relay.');
  const channel = values.channel;

  let literalToken: string | undefined;
  if (values['literal-token']) {
    if (channel !== 'http') usage('--literal-token only applies to --channel http.');
    literalToken = process.env[TOKEN_ENV];
    if (!literalToken) usage(`--literal-token needs ${TOKEN_ENV} set to the sink's token.`);
  }

  const port = sinkPort();
  const settings = buildSettings({
    scenario,
    channel,
    port,
    ...(literalToken === undefined ? {} : { literalToken }),
  });
  await mkdir(SETTINGS_DIR, { recursive: true });
  const file = path.join(SETTINGS_DIR, `${scenario}.${channel}.json`);
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${file}`);
  if (literalToken !== undefined) {
    console.log(
      'Note: this file contains the sink token. Regenerate it after restarting the sink.',
    );
  }
  console.log('');
  console.log('In the terminal where you set MICROMINDS_URL and MICROMINDS_HOOK_TOKEN (see the');
  console.log('sink output), from the scratch repo (never from micro-minds), run:');
  console.log(`  claude --settings "${file}"`);
}

if (import.meta.main) {
  await main();
}
