// Phase 1 recording driver (task 1.2). Runs real interactive `claude` sessions in a pseudo-terminal
// (node-pty; ConPTY on Windows), one per scenario, in the scratch repo, and drives each one from the
// hook events the capture sink receives rather than from screen timing. With the user's OK (PLAN
// Phase 1 "Before you start"): every run spends the user's tokens.
//
//   npm run spike:drive                 all scenarios, in order
//   npm run spike:drive -- b-read-edit  one or more by name
//   npm run spike:drive -- --list
//
// Threat assumption: the recorded agent holds the sink token (the hooks need it), so every hook
// event is untrusted. The driver never approves a permission prompt: it declines with Esc (scenario
// d), ends the scenario on any other PermissionRequest, presses Enter only when no permission dialog
// is on screen, and quits with Ctrl-C. A hostile agent can still jam the sink (a denial of service)
// but can't get an action approved.
//
// It starts the sink itself (port 47110 or SPIKE_SINK_PORT, a fresh token), prints only event names and timing, and
// never reads or prints payload contents. Raw captures go to ~/.micro-minds-dev/spike/captures/;
// an existing capture file for a scenario is kept, renamed with a timestamp.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { type IPty, spawn } from 'node-pty';
import { resolveOnPath } from '../../evals/harness/reviewer/resolve-bin.ts';
import { createTarget } from './make-target.ts';
import {
  CAPTURES_DIR,
  type Channel,
  captureFile,
  SETTINGS_DIR,
  SINK_HOST,
  SPIKE_DIR,
  sinkPort,
} from './paths.ts';
import { buildSettings } from './settings.ts';
import { type CaptureEvent, startSink } from './sink.ts';

const SECOND = 1000;

type Step =
  | { kind: 'prompt'; text: string }
  | { kind: 'wait'; event: string; tool?: string; timeoutMs: number; optional?: boolean }
  | { kind: 'waitAny'; events: string[]; timeoutMs: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'keys'; data: string; label: string }
  | { kind: 'kill' }
  | { kind: 'exit' };

interface Scenario {
  name: string;
  channel: Channel;
  /**
   * Decline permission prompts with Esc (scenario d). Otherwise any permission prompt ends the
   * scenario: the driver never approves one. Hook events can't be trusted as control input (the
   * recorded agent has the sink token and could post them), and Esc or a kill approves nothing.
   */
  denyPermissions?: boolean;
  /** Press Enter to pick the first option of an AskUserQuestion (scenario e). */
  answerQuestions?: boolean;
  /** Extra CLI arguments for this session only (never the user's settings). */
  args?: string[];
  steps: Step[];
}

const LONG_PROMPT = 'Explain every file in this repository in detail, one section per file.';
const turn = (text: string, timeoutMs = 180 * SECOND): Step[] => [
  { kind: 'prompt', text },
  { kind: 'wait', event: 'Stop', timeoutMs },
];

export const SCENARIOS: Scenario[] = [
  {
    name: 'a-qa',
    channel: 'http',
    steps: [
      ...turn("In one sentence, what is a pure function? Don't use any tools."),
      { kind: 'exit' },
    ],
  },
  {
    name: 'b-read-edit',
    channel: 'http',
    steps: [
      ...turn('Read src/math.js, then add a subtract(a, b) function after add().'),
      { kind: 'exit' },
    ],
  },
  {
    name: 'c-failing-shell',
    channel: 'http',
    steps: [
      ...turn('Run node scripts/fail.js with the Bash tool and tell me what happened.'),
      { kind: 'exit' },
    ],
  },
  {
    name: 'd-permission',
    channel: 'http',
    denyPermissions: true,
    // The user's default is auto mode, which approves the write without asking; this session
    // asks, so the permission prompt (and its hook events) actually happen.
    args: ['--permission-mode', 'default'],
    // Declining with Esc cancels the turn like an interrupt: no Stop follows, so don't require one.
    steps: [
      { kind: 'prompt', text: 'Create a file notes.txt containing the word hello.' },
      { kind: 'wait', event: 'PermissionRequest', timeoutMs: 120 * SECOND },
      { kind: 'wait', event: 'Stop', timeoutMs: 20 * SECOND, optional: true },
      { kind: 'exit' },
    ],
  },
  {
    name: 'e-ask-question',
    // AskUserQuestion's question dialog itself raises PermissionRequest(AskUserQuestion), even with
    // --allowedTools AskUserQuestion: the driver treats that event as the question, not a prompt.
    answerQuestions: true,
    channel: 'http',
    steps: [
      ...turn(
        'Use your AskUserQuestion tool to ask me whether I prefer option A or option B, then tell me which I picked.',
      ),
      { kind: 'exit' },
    ],
  },
  {
    name: 'f-subagent',
    channel: 'http',
    // The Agent tool can return at once and run the subagent in the background: the main turn's
    // Stop may come before SubagentStop, and the answer arrives in a later turn. Wait for both.
    steps: [
      {
        kind: 'prompt',
        text: 'Use the Agent tool to start a subagent that lists the files in this repository and describes each in one line, then give me its answer.',
      },
      { kind: 'wait', event: 'SubagentStop', timeoutMs: 300 * SECOND },
      { kind: 'wait', event: 'Stop', timeoutMs: 180 * SECOND, optional: true },
      { kind: 'sleep', ms: 3 * SECOND },
      { kind: 'exit' },
    ],
  },
  {
    name: 'g-ctrl-c',
    channel: 'http',
    steps: [
      { kind: 'prompt', text: LONG_PROMPT },
      { kind: 'waitAny', events: ['PreToolUse', 'Stop'], timeoutMs: 60 * SECOND },
      { kind: 'sleep', ms: 1500 },
      { kind: 'keys', data: '\x03', label: 'Ctrl-C (interrupt)' },
      { kind: 'sleep', ms: 5 * SECOND },
      { kind: 'keys', data: '\x03', label: 'Ctrl-C' },
      { kind: 'sleep', ms: 400 },
      { kind: 'keys', data: '\x03', label: 'Ctrl-C (quit)' },
      { kind: 'exit' },
    ],
  },
  {
    name: 'h-killed',
    channel: 'http',
    steps: [
      { kind: 'prompt', text: LONG_PROMPT },
      { kind: 'waitAny', events: ['PreToolUse', 'Stop'], timeoutMs: 60 * SECOND },
      { kind: 'sleep', ms: 1500 },
      { kind: 'kill' },
    ],
  },
  {
    name: 'i-compaction',
    channel: 'http',
    steps: [
      ...turn('What does src/greet.js do?'),
      ...turn('And src/math.js?'),
      { kind: 'prompt', text: '/compact' },
      { kind: 'wait', event: 'PreCompact', timeoutMs: 60 * SECOND },
      { kind: 'wait', event: 'SessionStart', timeoutMs: 240 * SECOND, optional: true },
      { kind: 'sleep', ms: 3 * SECOND },
      { kind: 'exit' },
    ],
  },
  {
    name: 'a-qa-relay',
    channel: 'relay',
    steps: [
      ...turn("In one sentence, what is a pure function? Don't use any tools."),
      { kind: 'exit' },
    ],
  },
  {
    name: 'b-read-edit-relay',
    channel: 'relay',
    steps: [
      ...turn('Read src/math.js, then add a subtract(a, b) function after add().'),
      { kind: 'exit' },
    ],
  },
];

/** Removes ANSI escape sequences so screen text can be searched. */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is exactly what's being removed.
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Environment for the recorded session: the user's own, minus this session's Claude Code vars. */
function childEnv(url: string, token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_PROJECT_DIR') {
      continue;
    }
    env[key] = value;
  }
  env.MICROMINDS_URL = url;
  env.MICROMINDS_HOOK_TOKEN = token;
  return env;
}

/**
 * A fresh scratch repo for one scenario, under ~/.micro-minds-dev/spike/targets/. Never a reset of
 * an old one: git in a repo the recorded agent could write to would run whatever hooks or filters it
 * planted, so git only ever runs on a directory nothing has touched yet (make-target.ts).
 */
function freshTarget(scenario: string): string {
  const dir = path.join(SPIKE_DIR, 'targets', `${scenario}-${Date.now()}`);
  createTarget(dir);
  return dir;
}

function keepOldCapture(scenario: string): void {
  const file = captureFile(CAPTURES_DIR, scenario);
  if (existsSync(file) && statSync(file).size > 0) {
    renameSync(file, `${file}.${Date.now()}.old`);
  }
}

interface Session {
  pty: IPty;
  events: CaptureEvent[];
  screen: () => string;
  exited: () => boolean;
  exitCode: () => number | undefined;
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' });
    } catch {
      // Already gone.
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

async function runScenario(
  scenario: Scenario,
  binary: string,
  port: number,
  url: string,
  token: string,
  subscribe: (fn: (e: CaptureEvent) => void) => () => void,
): Promise<{ ok: boolean; notes: string[]; events: CaptureEvent[] }> {
  const notes: string[] = [];
  keepOldCapture(scenario.name);
  const target = freshTarget(scenario.name);

  // Write this scenario's settings for the port the sink really listens on, so a stale file or a
  // different SPIKE_SINK_PORT can't send the hooks nowhere.
  mkdirSync(SETTINGS_DIR, { recursive: true });
  const settings = path.join(SETTINGS_DIR, `${scenario.name}.${scenario.channel}.json`);
  writeFileSync(
    settings,
    `${JSON.stringify(buildSettings({ scenario: scenario.name, channel: scenario.channel, port }), null, 2)}\n`,
  );
  const pty = spawn(binary, ['--settings', settings, ...(scenario.args ?? [])], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: target,
    env: childEnv(url, token),
  });
  let screen = '';
  // Screen output since the current AskUserQuestion started (undefined when none is pending).
  let sinceQuestion: string | undefined;
  let exitCode: number | undefined;
  let exited = false;
  pty.onData((data) => {
    const text = plain(data);
    screen = (screen + text).slice(-6000);
    if (sinceQuestion !== undefined) sinceQuestion = (sinceQuestion + text).slice(-20000);
  });
  pty.onExit(({ exitCode: code }) => {
    exited = true;
    exitCode = code;
  });

  const events: CaptureEvent[] = [];
  let answering = Promise.resolve();
  const unsubscribe = subscribe((event) => {
    if (event.scenario !== scenario.name) return;
    events.push(event);
    const isQuestionDialog =
      scenario.answerQuestions === true && event.toolName === 'AskUserQuestion';
    if (event.hookEventName === 'PermissionRequest' && !isQuestionDialog) {
      if (scenario.denyPermissions) {
        answering = answering.then(async () => {
          await sleep(3 * SECOND);
          pty.write('\x1b');
          notes.push(`declined the permission prompt for ${event.toolName ?? '?'} (Esc)`);
        });
      } else {
        notes.push(`unexpected permission prompt for ${event.toolName ?? '?'}: ended the scenario`);
        killTree(pty.pid);
      }
    }
    if (
      scenario.answerQuestions &&
      event.hookEventName === 'PreToolUse' &&
      event.toolName === 'AskUserQuestion'
    ) {
      // Press Enter only while the screen output since this event shows no permission dialog: the
      // event alone could be forged, and Enter on a dialog would approve it.
      sinceQuestion = '';
      answering = answering.then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await sleep(2 * SECOND);
          if (exited) break;
          const answered = events.some(
            (e) => e.hookEventName.startsWith('PostToolUse') && e.toolName === 'AskUserQuestion',
          );
          if (answered) break;
          const shown = (sinceQuestion ?? '').replace(/\s+/g, '').toLowerCase();
          // Only the question's own menu may be answered: it must be showing, and no permission
          // dialog ("Do you want…") may have appeared since the question started.
          if (!shown.includes('entertoselect')) {
            notes.push('the question menu is not showing yet: not pressing Enter');
            continue;
          }
          if (shown.includes('doyouwant')) {
            notes.push('a permission dialog is showing: not pressing Enter for the question');
            break;
          }
          pty.write('\r');
          notes.push('pressed Enter on the question (first option: A)');
        }
        sinceQuestion = undefined;
      });
    }
  });

  const session: Session = {
    pty,
    events,
    screen: () => screen,
    exited: () => exited,
    exitCode: () => exitCode,
  };

  // True when recent screen output shows a permission dialog ("Do you want to proceed?" and the
  // like). Old dialog text still in the window only makes this end a scenario early: the safe side.
  const dialogShowing = () =>
    screen.slice(-4000).replace(/\s+/g, '').toLowerCase().includes('doyouwant');

  const since = { index: 0 };
  async function waitFor(match: (e: CaptureEvent) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.slice(since.index).findIndex(match);
      if (found >= 0) {
        since.index += found + 1;
        return true;
      }
      if (session.exited()) return false;
      await sleep(250);
    }
    return false;
  }

  // Startup: wait for SessionStart. The only first-run screen answered is Claude Code's folder-trust
  // dialog, and only for the scratch repo this driver created (its default choice is "No, exit").
  // Any other screen is left alone and reported: pressing keys blind picks whatever is highlighted.
  // Ready means SessionStart arrived, or the input screen is showing (its footer names the
  // shift+tab mode cycle): SessionStart may not fire for an http hook, which is itself a finding.
  let started = false;
  let ready = false;
  let trusted = false;
  const startDeadline = Date.now() + 60 * SECOND;
  while (!ready && !exited && Date.now() < startDeadline) {
    started = await waitFor((e) => e.hookEventName === 'SessionStart', 3 * SECOND);
    const text = screen.replace(/\s+/g, '').toLowerCase();
    if (!started && !trusted && text.includes('itrustthisfolder')) {
      pty.write('\x1b[B'); // down to "Yes, I trust this folder"
      await sleep(400);
      pty.write('\r');
      trusted = true;
      screen = '';
      notes.push(`accepted the folder-trust dialog for ${target}`);
      continue;
    }
    // Auto mode's footer says "shift+tab to cycle"; the default mode's says "? for shortcuts".
    ready = started || text.includes('shift+tabtocycle') || text.includes('?forshortcuts');
  }
  if (!started) notes.push('no SessionStart event before the input screen appeared');
  if (!ready) {
    notes.push(`screen at startup: ${screen.slice(-200).replace(/\s+/g, ' ').trim()}`);
    notes.push('input screen never appeared');
    killTree(pty.pid);
    unsubscribe();
    return { ok: false, notes, events };
  }
  await sleep(2500);

  let ok = true;
  for (const step of scenario.steps) {
    if (exited && step.kind !== 'exit') {
      notes.push(`session exited early (code ${exitCode}) before ${step.kind}`);
      ok = false;
      break;
    }
    switch (step.kind) {
      case 'prompt':
        // Enter would approve a permission dialog, so never press it while one may be showing.
        if (dialogShowing()) {
          notes.push('a permission dialog is on screen: ended the scenario instead of typing');
          killTree(pty.pid);
          ok = false;
          break;
        }
        pty.write(step.text);
        await sleep(600);
        if (dialogShowing()) {
          notes.push('a permission dialog appeared: ended the scenario instead of pressing Enter');
          killTree(pty.pid);
          ok = false;
          break;
        }
        pty.write('\r');
        break;
      case 'wait': {
        const seen = await waitFor(
          (e) =>
            e.hookEventName === step.event && (step.tool === undefined || e.toolName === step.tool),
          step.timeoutMs,
        );
        if (!seen) {
          notes.push(`timed out waiting for ${step.event}`);
          if (!step.optional) ok = false;
        }
        break;
      }
      case 'waitAny': {
        const seen = await waitFor((e) => step.events.includes(e.hookEventName), step.timeoutMs);
        if (!seen) notes.push(`none of ${step.events.join('/')} arrived; continuing`);
        break;
      }
      case 'sleep':
        await sleep(step.ms);
        break;
      case 'keys':
        pty.write(step.data);
        notes.push(`sent ${step.label}`);
        break;
      case 'kill':
        killTree(pty.pid);
        notes.push('killed the process tree');
        break;
      case 'exit':
        // Quit with Ctrl-C twice: unlike /exit plus Enter, it can never approve a dialog.
        if (!exited) {
          pty.write('\x03');
          await sleep(400);
          pty.write('\x03');
        }
        break;
    }
    if (!ok) break;
  }

  const deadline = Date.now() + 30 * SECOND;
  while (!exited && Date.now() < deadline) await sleep(250);
  if (!exited) {
    notes.push('still running after exit; killed it');
    killTree(pty.pid);
  }
  await answering;
  await sleep(1500); // Let late hooks (SessionEnd) arrive.
  unsubscribe();
  if (!ok) notes.push(`screen tail: ${screen.slice(-300).replace(/\s+/g, ' ').trim()}`);
  return { ok, notes, events };
}

function summarize(events: CaptureEvent[]): string {
  return events
    .map((e) => (e.toolName === undefined ? e.hookEventName : `${e.hookEventName}(${e.toolName})`))
    .join(' → ');
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--list')) {
    for (const s of SCENARIOS) console.log(`${s.name} (${s.channel})`);
    return 0;
  }
  const wanted = argv.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => argv.includes(s.name));
  const unknown = argv.filter((a) => !SCENARIOS.some((s) => s.name === a));
  if (unknown.length > 0) {
    console.error(`unknown scenario(s): ${unknown.join(', ')} (see --list)`);
    return 2;
  }
  const resolved = resolveOnPath('claude', {
    platform: process.platform,
    pathEnv: process.env.PATH,
    pathExt: process.env.PATHEXT,
    isFile: (p) => existsSync(p) && statSync(p).isFile(),
  });
  if (resolved === undefined || resolved.needsShell) {
    console.error('claude.exe (or a non-shim claude binary) not found on PATH');
    return 2;
  }

  const port = sinkPort();
  const token = randomBytes(24).toString('base64url');
  const listeners = new Set<(e: CaptureEvent) => void>();
  const server = await startSink({
    port,
    token,
    capturesDir: CAPTURES_DIR,
    // Show rejected requests (a wrong token, a bad scenario name): they explain missing events.
    log: (line) => {
      if (line.startsWith('rejected')) console.log(`  sink: ${line}`);
    },
    onCapture: (event) => {
      for (const listener of listeners) listener(event);
    },
  });
  const url = `http://${SINK_HOST}:${port}`;
  const subscribe = (fn: (e: CaptureEvent) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  let failures = 0;
  try {
    for (const scenario of wanted) {
      const started = Date.now();
      console.log(`\n[${scenario.name}] (${scenario.channel}) starting`);
      const result = await runScenario(scenario, resolved.path, port, url, token, subscribe);
      const seconds = Math.round((Date.now() - started) / SECOND);
      console.log(
        `[${scenario.name}] ${result.ok ? 'OK' : 'INCOMPLETE'} in ${seconds}s, ${result.events.length} event(s)`,
      );
      console.log(`  events: ${summarize(result.events) || '(none)'}`);
      for (const note of result.notes) console.log(`  note: ${note}`);
      if (!result.ok) failures++;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(
    `\n${wanted.length - failures}/${wanted.length} scenario(s) completed; captures in ${CAPTURES_DIR}`,
  );
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  // Exit explicitly: node-pty's ConPTY handles can keep the event loop alive after the last session.
  process.exit(await main(process.argv.slice(2)));
}
