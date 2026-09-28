// Tasks 1.7 and 1.8: scrub the raw captures into fixtures/claude/<scenario>.jsonl (the
// record-fixture skill, steps 1-2). Each output line is one payload as Claude Code sent it (a hook
// payload, an OTLP metrics export, or a status-line stdin JSON): field names and structure
// untouched, only values replaced, with the same real value always mapping to the same placeholder
// within a file. Probe-channel records (task 1.3 experiments) are left out.
//
//   npm run spike:scrub
//
// It reads only the sink's captures, never a provider file, and never opens a transcript_path
// (hard rule 1). The output must still pass the skill's step 4 checks before it is committed.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CAPTURES_DIR } from './paths.ts';

/** Capture file (in CAPTURES_DIR) → fixture scenario name (behavior, not date: record-fixture). */
export const FIXTURES: Record<string, string> = {
  'a-qa.jsonl': 'qa',
  'a-qa-relay.jsonl': 'qa-command-hook',
  'b-read-edit.jsonl': 'read-edit',
  'c-failing-shell.jsonl': 'failing-shell',
  // The first recording of (c), kept by drive.ts when (c) was re-recorded: the agent wrapped the
  // command in `; echo $?`, so the failure arrived as a PostToolUse (SCENARIOS.md, finding 3).
  'c-failing-shell.jsonl.1790570916999.old': 'failing-shell-masked',
  'd-permission.jsonl': 'permission-prompt',
  'e-ask-question.jsonl': 'ask-user-question',
  'f-subagent.jsonl': 'subagent',
  'g-ctrl-c.jsonl': 'ctrl-c',
  'h-killed.jsonl': 'process-killed',
  'i-compaction.jsonl': 'compaction',
  // Task 1.8: OpenTelemetry metric exports (one OTLP/JSON body per line; logs are left out, since
  // ADR 0030 ingests metrics only) and the status-line JSON (one stdin payload per line).
  'otel-t-qa.jsonl': 'otel-qa',
  'otel-t-read-edit.jsonl': 'otel-read-edit',
  'otel-t-subagent.jsonl': 'otel-subagent',
  'statusline-t-qa.jsonl': 'statusline-qa',
  'statusline-t-read-edit.jsonl': 'statusline-read-edit',
  'statusline-t-subagent.jsonl': 'statusline-subagent',
};

/** OTLP attributes that identify the account: replaced by key, whatever their value looks like. */
const ACCOUNT_ATTRIBUTES = new Set([
  'user.id',
  'user.email',
  'user.account_uuid',
  'user.account_id',
  'organization.id',
]);

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/claude/', import.meta.url));
const MAX_STRING = 400;
const KEEP_CHARS = 200;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_RES = [
  /sk-(ant-)?[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /(bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi,
];

interface Maps {
  uuids: Map<string, string>;
  agents: Map<string, string>;
  toolUses: Map<string, string>;
  accounts: Map<string, string>;
}

/** A placeholder of the same length: `user@example.com` for an email, a hex counter otherwise. */
const accountPlaceholder = (real: string) => (n: number) =>
  real.includes('@') ? 'user@example.com' : n.toString(16).padStart(real.length, '0');

function mapped(map: Map<string, string>, real: string, make: (n: number) => string): string {
  let value = map.get(real);
  if (value === undefined) {
    value = make(map.size + 1);
    map.set(real, value);
  }
  return value;
}

/** An agent id keeps its length and first character; the rest becomes a hex counter. */
const agentPlaceholder = (real: string) => (n: number) =>
  `${real[0] ?? 'a'}${n.toString(16).padStart(Math.max(real.length - 1, 1), '0')}`;

/** Any word (letters, digits, `_`) that contains `term`, case-insensitively. */
const wordsContaining = (term: string) =>
  new RegExp(`[A-Za-z0-9_]*${escapeRe(term)}[A-Za-z0-9_]*`, 'gi');
/** `term` as a whole word, case-insensitively. */
const wholeWord = (term: string) => new RegExp(`\\b${escapeRe(term)}\\b`, 'gi');

let ownerTerms: string[] | undefined;
/**
 * The repository owner's name from `git config user.name` (a repo setting, not a credential
 * file): the full name first, then each part, since an agent's reply can use it.
 */
function ownerNameTerms(): string[] {
  if (ownerTerms === undefined) {
    let name = '';
    try {
      name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
    } catch {
      // No git name configured: nothing to add.
    }
    const parts = name.split(/\s+/).filter((p) => p.length > 1);
    ownerTerms = name === '' ? [] : [...new Set([name, ...parts])];
  }
  return ownerTerms;
}

function scrubString(value: string, maps: Maps): string {
  const home = homedir();
  const user = userInfo().username;
  const host = hostname();
  let s = value;
  // Scratch repositories (any separator style, and Claude Code's dash-slug of their path).
  const spike = path.join(home, '.micro-minds-dev', 'spike', 'targets');
  const legacy = path.join(home, 'micro-minds-spike-target');
  for (const sep of ['\\', '/']) {
    const h = home.split(path.sep).join(sep);
    const t = spike.split(path.sep).join(sep);
    const l = legacy.split(path.sep).join(sep);
    const repo = `${h}${sep}projects${sep}sample-repo`;
    s = s.replace(new RegExp(`${escapeRe(t)}${escapeRe(sep)}[A-Za-z0-9-]+-\\d{13}`, 'gi'), repo);
    s = s.replace(new RegExp(escapeRe(l), 'gi'), repo);
  }
  s = s.replace(
    /C--Users-[^-\\/"]+--micro-minds-dev-spike-targets-[a-z0-9-]+?-\d{13}/gi,
    'C--Users-user-projects-sample-repo',
  );
  s = s.replace(
    /C--Users-[^-\\/"]+-micro-minds-spike-target/gi,
    'C--Users-user-projects-sample-repo',
  );
  // Ids seen in this file (collected first), then any other UUID.
  for (const [real, placeholder] of [...maps.agents, ...maps.toolUses]) {
    s = s.split(real).join(placeholder);
  }
  s = s.replace(UUID_RE, (m) => mapped(maps.uuids, m.toLowerCase(), uuid));
  // The machine, the owner's name and the user: whole words, longest first, so a hostname or a
  // first name that contains the username becomes a placeholder rather than a hybrid.
  s = s.replace(wordsContaining(host), 'host');
  for (const term of ownerNameTerms()) s = s.replace(wholeWord(term), 'user');
  s = s.replace(wordsContaining(user), 'user');
  s = s.replace(EMAIL_RE, (m) => (m === 'user@example.com' ? m : 'user@example.com'));
  for (const re of SECRET_RES) {
    s = s.replace(re, (_m, prefix: unknown) =>
      typeof prefix === 'string' && /bearer/i.test(prefix) ? `${prefix}<redacted>` : '<redacted>',
    );
  }
  // Long text (file contents, patches, replies): keep the start of the first line only.
  if (s.length > MAX_STRING) s = `${s.split('\n')[0]?.slice(0, KEEP_CHARS) ?? ''} …[trimmed]`;
  return s;
}

function scrubValue(value: unknown, maps: Maps): unknown {
  if (typeof value === 'string') return scrubString(value, maps);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, maps));
  if (value !== null && typeof value === 'object') {
    // An OTLP attribute, { key, value: { stringValue } }, that identifies the account.
    const attribute = value as { key?: unknown; value?: { stringValue?: unknown } };
    if (
      typeof attribute.key === 'string' &&
      ACCOUNT_ATTRIBUTES.has(attribute.key) &&
      typeof attribute.value?.stringValue === 'string'
    ) {
      const real = attribute.value.stringValue;
      // A UUID stays a UUID (organization.id), from the same sequence as every other UUID.
      const placeholder = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        real,
      )
        ? mapped(maps.uuids, real.toLowerCase(), uuid)
        : mapped(maps.accounts, real, accountPlaceholder(real));
      return { key: attribute.key, value: { stringValue: placeholder } };
    }
    return Object.fromEntries(
      // Keys can hold free text too (AskUserQuestion's `answers` is keyed by the question).
      Object.entries(value).map(([k, v]) => [scrubString(k, maps), scrubValue(v, maps)] as const),
    );
  }
  return value;
}

/** Placeholders for paths that point into provider state: never opened, never kept. */
function placeholderPaths(body: Record<string, unknown>): void {
  const session = typeof body.session_id === 'string' ? body.session_id : uuid(1);
  const home = 'C:\\Users\\user';
  const project = `${home}\\.claude\\projects\\sample-repo`;
  if ('transcript_path' in body) body.transcript_path = `${project}\\${session}.jsonl`;
  if ('agent_transcript_path' in body) {
    const agent = typeof body.agent_id === 'string' ? body.agent_id : 'agent';
    body.agent_transcript_path = `${project}\\${session}\\subagents\\agent-${agent}.jsonl`;
  }
  // The status line's plan usage (`rate_limits`) describes the account: keep the shape, not the
  // numbers (a fixed percentage and a fixed reset time, 2026-01-01T00:00:00Z).
  const limits = body.rate_limits;
  if (limits !== null && typeof limits === 'object') {
    for (const window of Object.values(limits)) {
      if (window === null || typeof window !== 'object') continue;
      const w = window as Record<string, unknown>;
      if ('used_percentage' in w) w.used_percentage = 0;
      if ('resets_at' in w) w.resets_at = 1767225600;
    }
  }
  if ('scratchpad_dir' in body) {
    body.scratchpad_dir = `${home}\\AppData\\Local\\Temp\\claude\\sample-repo\\${session}\\scratchpad`;
  }
}

function collectIds(bodies: Record<string, unknown>[], maps: Maps): void {
  const agent = (id: unknown) => {
    if (typeof id === 'string' && id !== '') mapped(maps.agents, id, agentPlaceholder(id));
  };
  for (const b of bodies) {
    agent(b.agent_id);
    const response = b.tool_response;
    if (response !== null && typeof response === 'object' && 'agentId' in response) {
      agent((response as { agentId: unknown }).agentId);
    }
    for (const task of Array.isArray(b.background_tasks) ? b.background_tasks : []) {
      if (task !== null && typeof task === 'object' && 'id' in task) agent(task.id);
    }
    if (typeof b.tool_use_id === 'string') {
      const [prefix] = b.tool_use_id.split('_');
      mapped(maps.toolUses, b.tool_use_id, (n) => `${prefix}_${n.toString().padStart(6, '0')}`);
    }
  }
}

export function scrubCapture(lines: string[]): string[] {
  const bodies: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const record: unknown = JSON.parse(line);
    if (record === null || typeof record !== 'object') continue;
    const { channel, signal, body } = record as {
      channel?: unknown;
      signal?: unknown;
      body?: unknown;
    };
    if (channel === 'probe' || body === null || typeof body !== 'object') continue;
    // OpenTelemetry captures: metrics only (ADR 0030).
    if (signal !== undefined && signal !== 'metrics') continue;
    bodies.push(body as Record<string, unknown>);
  }
  const maps: Maps = {
    uuids: new Map(),
    agents: new Map(),
    toolUses: new Map(),
    accounts: new Map(),
  };
  collectIds(bodies, maps);
  return bodies.map((b) => {
    const scrubbed = scrubValue(b, maps) as Record<string, unknown>;
    placeholderPaths(scrubbed);
    return JSON.stringify(scrubbed);
  });
}

function main(): number {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [capture, scenario] of Object.entries(FIXTURES)) {
    const source = path.join(CAPTURES_DIR, capture);
    if (!existsSync(source)) {
      console.error(`missing capture: ${capture}`);
      return 1;
    }
    const out = scrubCapture(readFileSync(source, 'utf8').split('\n'));
    writeFileSync(path.join(FIXTURES_DIR, `${scenario}.jsonl`), `${out.join('\n')}\n`, 'utf8');
    console.log(`${scenario}.jsonl: ${out.length} event(s)`);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
