// Task 2.3, clause C3: the conformance suite every ProviderAdapter must pass (PLAN §5, §11, D10).
// `describeConformance` registers one Vitest `it` per check; each check is also a pure function
// (`runConformanceCheck`, `conformanceViolations`) so the suite's own tests can show that it
// catches broken adapters (clause C4). Checks never throw: whatever an adapter does becomes a
// violation message. Deterministic: fixed ids, a fixed receipt time and fixed fast-check seeds.
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  EVENT_KINDS,
  EVENT_SCHEMA_VERSION,
  isProvider,
  parseAgentEvent,
  TOOL_CATEGORIES,
} from '@micro-minds/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LaunchContext, NormalizeContext, ProviderAdapter } from './types.ts';

export interface ConformanceOptions {
  /** Raw provider payloads (one parsed fixture line each), fed to `normalize` as they are. */
  fixtures: readonly unknown[];
}

/** Our session id (a ULID). The root agent's id equals it (PLAN §4.1). */
export const CONFORMANCE_SESSION_ID = '01K6A2B3C4D5E6F7G8H9J0K1M2';
/** A fixed receipt time (ms epoch); adapters must stamp exactly this. */
export const CONFORMANCE_RECEIVED_AT = 1_790_000_123_456;
/** A distinctive hook token, so any leak into args or files is found by substring. */
export const CONFORMANCE_HOOK_TOKEN = 'mmhook-conformance-Q7x2Z9w4K8v1R5t3Y6u0';
export const CONFORMANCE_SERVER_URL = 'http://127.0.0.1:4317';
/** Absolute on every OS (a drive letter is added on Windows). Never touched on disk. */
export const CONFORMANCE_WORKTREE = path.resolve(
  path.sep,
  'mm-conformance',
  'worktrees',
  'sample-repo',
  CONFORMANCE_SESSION_ID,
);
export const CONFORMANCE_SESSION_DIR = path.resolve(
  path.sep,
  'mm-conformance',
  'sessions',
  CONFORMANCE_SESSION_ID,
);

/** The fixed seed for every fast-check sample the suite draws. */
export const CONFORMANCE_SEED = 20_260_928;

/** First prompts that a shell or quoting layer would mangle; each must reach argv unchanged. */
export const TRICKY_PROMPTS: readonly string[] = [
  'fix the failing test',
  'say "hello" and \'goodbye\'',
  'a & b | c > d < e ^ f; g',
  'expand %PATH% and !VAR! please',
  // `${HOME}`, built so it is not read as a template placeholder by mistake.
  ['run $(rm -rf /) and `whoami` and $', '{HOME}'].join(''),
  'line one\nline two\r\nline three',
  '  leading and trailing spaces  ',
  'path C:\\Program Files\\tool "quoted\\" end\\',
  "it's a 'single' quote test",
];

/** Payloads no provider recognizes: they must yield only `unknown` events (hard rule 7). */
export const UNRECOGNIZED_PAYLOADS: readonly unknown[] = [
  {
    hook_event_name: 'MicroMindsConformanceUnrecognized',
    event: 'micro-minds.conformance.unrecognized',
    type: 'micro-minds.conformance.unrecognized',
    kind: 'micro-minds.conformance.unrecognized',
    name: 'micro-minds.conformance.unrecognized',
    session_id: '00000000-0000-4000-8000-00000000c0f1',
  },
  { hook_event_name: 'NoSuchHookEver', payload: { nested: [1, 2, 3] } },
  { event: 'no.such.event.ever', data: 'nothing' },
];

const ALLOWED_EVENT_KEYS: ReadonlySet<string> = new Set([
  'v',
  'id',
  'ts',
  'sessionId',
  'provider',
  'agentId',
  'parentAgentId',
  'kind',
  'tool',
  'text',
  'errorClass',
  'usage',
  'raw',
]);
const ALLOWED_TOOL_KEYS: ReadonlySet<string> = new Set(['name', 'category', 'useId', 'summary']);
const HOOK_MODES: readonly string[] = ['http', 'relay', 'none'];
const MAX_MESSAGES = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    return 'an unprintable error';
  }
}

export interface IssuedContext {
  ctx: NormalizeContext;
  /** Every id `ctx.newId()` has returned, in order. */
  issued: string[];
}

/** A fresh NormalizeContext whose `newId` returns deterministic ULID-shaped ids. */
export function makeNormalizeContext(): IssuedContext {
  const issued: string[] = [];
  let n = 0;
  return {
    issued,
    ctx: {
      sessionId: CONFORMANCE_SESSION_ID,
      receivedAt: CONFORMANCE_RECEIVED_AT,
      newId: () => {
        n += 1;
        const id = `01K6E${String(n).padStart(21, '0')}`;
        issued.push(id);
        return id;
      },
    },
  };
}

export function makeLaunchContext(firstPrompt?: string): LaunchContext {
  const base: LaunchContext = {
    sessionId: CONFORMANCE_SESSION_ID,
    serverUrl: CONFORMANCE_SERVER_URL,
    hookToken: CONFORMANCE_HOOK_TOKEN,
    sessionDir: CONFORMANCE_SESSION_DIR,
    worktreePath: CONFORMANCE_WORKTREE,
  };
  return firstPrompt === undefined ? base : { ...base, firstPrompt };
}

function nestedObject(depth: number): unknown {
  let value: unknown = { leaf: true };
  for (let i = 0; i < depth; i++) value = { nested: value, i };
  return value;
}

function nestedArray(depth: number): unknown {
  let value: unknown = ['leaf'];
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

/** Hostile and malformed inputs, independent of any provider's fixtures. */
export const EDGE_INPUTS: readonly { name: string; value: unknown }[] = [
  { name: 'null', value: null },
  { name: 'undefined', value: undefined },
  { name: 'empty string', value: '' },
  { name: 'plain string', value: 'PreToolUse' },
  { name: 'JSON text', value: '{"hook_event_name":"PreToolUse","tool_name":"Read"}' },
  { name: 'zero', value: 0 },
  { name: 'negative number', value: -1 },
  { name: 'NaN', value: Number.NaN },
  { name: 'Infinity', value: Number.POSITIVE_INFINITY },
  { name: 'true', value: true },
  { name: 'false', value: false },
  { name: 'empty array', value: [] },
  { name: 'array of numbers', value: [1, 2, 3] },
  {
    name: 'array of objects',
    value: [{}, { hook_event_name: 'Stop' }, { event: 'turn.finished' }],
  },
  { name: 'empty object', value: {} },
  { name: 'null-prototype object', value: Object.create(null) },
  { name: '__proto__ key', value: JSON.parse('{"__proto__":{"polluted":true},"event":1}') },
  { name: 'event name of the wrong type', value: { hook_event_name: 42, event: null, type: {} } },
  {
    name: 'known-looking event with wrong field types',
    value: {
      hook_event_name: 'PreToolUse',
      event: 'tool.started',
      tool_name: 7,
      tool: ['Read'],
      tool_input: 'not an object',
      agent_id: {},
      agent: 3,
      session_id: [],
    },
  },
  { name: 'deeply nested object', value: nestedObject(2_000) },
  { name: 'deeply nested array', value: nestedArray(2_000) },
  { name: 'very long string field', value: { event: 'x'.repeat(200_000) } },
];

function sampledAnything(): unknown[] {
  return fc.sample(fc.anything({ withNullPrototype: true, withSparseArray: true }), {
    seed: CONFORMANCE_SEED,
    numRuns: 200,
  });
}

function sampledObjects(): unknown[] {
  return fc.sample(fc.object(), { seed: CONFORMANCE_SEED + 1, numRuns: 100 });
}

interface LabeledInput {
  label: string;
  value: unknown;
}

function fixedInputs(options: ConformanceOptions): LabeledInput[] {
  return [
    ...options.fixtures.map((value, i) => ({ label: `fixture #${i}`, value })),
    ...EDGE_INPUTS.map(({ name, value }) => ({ label: `edge input "${name}"`, value })),
    ...UNRECOGNIZED_PAYLOADS.map((value, i) => ({ label: `unrecognized payload #${i}`, value })),
  ];
}

function allInputs(options: ConformanceOptions): LabeledInput[] {
  return [
    ...fixedInputs(options),
    ...sampledAnything().map((value, i) => ({ label: `fc.anything() sample #${i}`, value })),
  ];
}

type Outcome =
  | { ok: true; events: unknown; issued: readonly string[] }
  | { ok: false; error: string };

function callNormalize(adapter: ProviderAdapter, raw: unknown): Outcome {
  const { ctx, issued } = makeNormalizeContext();
  try {
    const events: unknown = adapter.normalize(raw, ctx);
    return { ok: true, events, issued };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** The events of every input for which normalize returned an array. */
function arrayOutcomes(
  adapter: ProviderAdapter,
  inputs: readonly LabeledInput[],
): { label: string; events: readonly unknown[]; issued: readonly string[] }[] {
  const out: { label: string; events: readonly unknown[]; issued: readonly string[] }[] = [];
  for (const { label, value } of inputs) {
    const outcome = callNormalize(adapter, value);
    if (outcome.ok && Array.isArray(outcome.events)) {
      out.push({ label, events: outcome.events, issued: outcome.issued });
    }
  }
  return out;
}

function checkIdentity(adapter: ProviderAdapter): string[] {
  const v: string[] = [];
  const id: unknown = adapter.id;
  if (!isProvider(id)) v.push(`id ${JSON.stringify(id)} is not one of shared's PROVIDERS`);
  const binary: unknown = adapter.binary;
  if (!isRecord(binary)) {
    v.push('binary is not an object');
  } else {
    const command = binary.command;
    if (typeof command !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(command)) {
      v.push(
        `binary.command ${JSON.stringify(command)} is not a bare command name (no path, separator, '..' or extension)`,
      );
    }
    const versionArgs = binary.versionArgs;
    if (!Array.isArray(versionArgs) || !versionArgs.every((a) => typeof a === 'string')) {
      v.push('binary.versionArgs is not an array of strings');
    }
  }
  const hooks: unknown = adapter.hooks;
  if (typeof hooks !== 'string' || !HOOK_MODES.includes(hooks)) {
    v.push(`hooks ${JSON.stringify(hooks)} is not 'http', 'relay' or 'none'`);
  }
  const categories: unknown = adapter.toolCategories;
  if (!isRecord(categories)) {
    v.push('toolCategories is not an object');
  } else {
    for (const [name, category] of Object.entries(categories)) {
      if (
        typeof category !== 'string' ||
        !(TOOL_CATEGORIES as readonly string[]).includes(category)
      ) {
        v.push(
          `toolCategories[${JSON.stringify(name)}] = ${JSON.stringify(category)} is not a ToolCategory`,
        );
      }
    }
  }
  return v;
}

function checkTotal(adapter: ProviderAdapter, options: ConformanceOptions): string[] {
  const v: string[] = [];
  for (const { label, value } of allInputs(options)) {
    const outcome = callNormalize(adapter, value);
    if (!outcome.ok) v.push(`normalize threw on ${label}: ${outcome.error}`);
    else if (!Array.isArray(outcome.events)) v.push(`normalize returned a non-array for ${label}`);
  }
  return v;
}

function checkEvents(adapter: ProviderAdapter, options: ConformanceOptions): string[] {
  const v: string[] = [];
  for (const { label, events, issued } of arrayOutcomes(adapter, allInputs(options))) {
    const seen = new Set<string>();
    events.forEach((event, i) => {
      const at = `${label}, event #${i}`;
      if (!isRecord(event)) {
        v.push(`${at} is not an object`);
        return;
      }
      if (!parseAgentEvent(event).ok) v.push(`${at} does not parse with parseAgentEvent`);
      if (event.v !== EVENT_SCHEMA_VERSION) v.push(`${at} has v ${String(event.v)}`);
      if (
        typeof event.kind !== 'string' ||
        !(EVENT_KINDS as readonly string[]).includes(event.kind)
      ) {
        v.push(`${at} has kind ${JSON.stringify(event.kind)}, not one of EVENT_KINDS`);
      }
      if (event.provider !== adapter.id) {
        v.push(`${at} has provider ${JSON.stringify(event.provider)}, not ${adapter.id}`);
      }
      if (event.sessionId !== CONFORMANCE_SESSION_ID) {
        v.push(`${at} has sessionId ${JSON.stringify(event.sessionId)}, not ctx.sessionId`);
      }
      if (event.ts !== CONFORMANCE_RECEIVED_AT) {
        v.push(`${at} has ts ${String(event.ts)}, not ctx.receivedAt`);
      }
      if (typeof event.id !== 'string' || !issued.includes(event.id)) {
        v.push(`${at} has id ${JSON.stringify(event.id)}, which ctx.newId() never returned`);
      } else if (seen.has(event.id)) {
        v.push(`${at} reuses id ${event.id}`);
      } else {
        seen.add(event.id);
      }
      if (event.parentAgentId === undefined && event.agentId !== CONFORMANCE_SESSION_ID) {
        v.push(
          `${at} is a root-agent event (no parentAgentId) whose agentId ${JSON.stringify(event.agentId)} is not ctx.sessionId`,
        );
      }
    });
  }
  return v;
}

function checkFactsOnly(adapter: ProviderAdapter, options: ConformanceOptions): string[] {
  const v: string[] = [];
  for (const { label, events } of arrayOutcomes(adapter, allInputs(options))) {
    events.forEach((event, i) => {
      if (!isRecord(event)) return;
      for (const key of Object.keys(event)) {
        if (!ALLOWED_EVENT_KEYS.has(key)) {
          v.push(
            `${label}, event #${i} sets ${JSON.stringify(key)}, which is not an AgentEvent fact`,
          );
        }
      }
      const tool = event.tool;
      if (isRecord(tool)) {
        for (const key of Object.keys(tool)) {
          if (!ALLOWED_TOOL_KEYS.has(key)) {
            v.push(`${label}, event #${i} sets tool.${key}, which is not an AgentEvent fact`);
          }
        }
      }
    });
  }
  return v;
}

function checkUnknownInput(adapter: ProviderAdapter): string[] {
  const v: string[] = [];
  const inputs: LabeledInput[] = [
    ...UNRECOGNIZED_PAYLOADS.map((value, i) => ({ label: `unrecognized payload #${i}`, value })),
    ...sampledObjects().map((value, i) => ({ label: `fc.object() sample #${i}`, value })),
  ];
  for (const { label, value } of inputs) {
    const outcome = callNormalize(adapter, value);
    if (!outcome.ok) {
      v.push(`normalize threw on ${label}: ${outcome.error}`);
      continue;
    }
    if (!Array.isArray(outcome.events)) {
      v.push(`normalize returned a non-array for ${label}`);
      continue;
    }
    outcome.events.forEach((event, i) => {
      if (!isRecord(event) || event.kind !== 'unknown') {
        v.push(
          `${label}, event #${i} has kind ${JSON.stringify(isRecord(event) ? event.kind : event)}, not 'unknown'`,
        );
      }
    });
  }
  const primary = callNormalize(adapter, UNRECOGNIZED_PAYLOADS[0]);
  const unknowns =
    primary.ok && Array.isArray(primary.events)
      ? primary.events.filter(
          (e): e is Record<string, unknown> => isRecord(e) && e.kind === 'unknown',
        )
      : [];
  if (unknowns.length === 0) {
    v.push('the canonical unrecognized payload yields no unknown event');
  } else if (!unknowns.some((e) => e.raw !== undefined)) {
    v.push('the unknown event for the canonical unrecognized payload does not keep raw');
  }
  return v;
}

function checkToolCategories(adapter: ProviderAdapter, options: ConformanceOptions): string[] {
  const v: string[] = [];
  const map: Readonly<Record<string, unknown>> = isRecord(adapter.toolCategories)
    ? adapter.toolCategories
    : {};
  for (const { label, events } of arrayOutcomes(adapter, allInputs(options))) {
    events.forEach((event, i) => {
      if (!isRecord(event) || !isRecord(event.tool)) return;
      const name = event.tool.name;
      if (typeof name !== 'string') {
        v.push(`${label}, event #${i} has a tool without a string name`);
        return;
      }
      const expected = Object.hasOwn(map, name) ? map[name] : 'other';
      if (event.tool.category !== expected) {
        v.push(
          `${label}, event #${i}: tool ${JSON.stringify(name)} has category ${JSON.stringify(event.tool.category)}, expected ${JSON.stringify(expected)}`,
        );
      }
    });
  }
  return v;
}

function checkDeterministic(adapter: ProviderAdapter, options: ConformanceOptions): string[] {
  const v: string[] = [];
  for (const { label, value } of fixedInputs(options)) {
    const first = callNormalize(adapter, value);
    const second = callNormalize(adapter, value);
    if (first.ok !== second.ok) {
      v.push(`normalize threw on only one of two identical calls for ${label}`);
    } else if (first.ok && second.ok && !isDeepStrictEqual(first.events, second.events)) {
      v.push(`two identical calls gave different output for ${label}`);
    }
  }
  return v;
}

function plainFileName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !path.posix.isAbsolute(name) &&
    !path.win32.isAbsolute(name) &&
    path.win32.parse(name).root === ''
  );
}

function checkLaunch(adapter: ProviderAdapter): string[] {
  const v: string[] = [];
  const worktreeForms = [CONFORMANCE_WORKTREE, CONFORMANCE_WORKTREE.replaceAll('\\', '/')];
  const cases: { label: string; prompt: string | undefined }[] = [
    { label: 'launch without a first prompt', prompt: undefined },
    ...TRICKY_PROMPTS.map((prompt) => ({
      label: `launch with prompt ${JSON.stringify(prompt)}`,
      prompt,
    })),
  ];
  for (const { label, prompt } of cases) {
    let spec: unknown;
    try {
      spec = adapter.launch(makeLaunchContext(prompt));
    } catch (error) {
      v.push(`${label} threw: ${describeError(error)}`);
      continue;
    }
    if (!isRecord(spec)) {
      v.push(`${label} returned a non-object`);
      continue;
    }
    const { args, env, files } = spec;
    const argList: string[] = [];
    if (!Array.isArray(args) || !args.every((a): a is string => typeof a === 'string')) {
      v.push(`${label}: args is not an array of strings`);
    } else {
      argList.push(...args);
    }
    const envValues: string[] = [];
    if (!isRecord(env)) {
      v.push(`${label}: env is not an object`);
    } else {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') v.push(`${label}: env.${key} is not a string`);
        else envValues.push(value);
      }
    }
    if (!Array.isArray(files)) {
      v.push(`${label}: files is not an array`);
    } else {
      files.forEach((file: unknown, i) => {
        if (!isRecord(file) || typeof file.name !== 'string' || typeof file.content !== 'string') {
          v.push(`${label}: files[${i}] is not { name: string; content: string }`);
          return;
        }
        if (!plainFileName(file.name)) {
          v.push(`${label}: file name ${JSON.stringify(file.name)} is not a plain name`);
        }
        if (file.name.includes(CONFORMANCE_HOOK_TOKEN)) {
          v.push(`${label}: the hook token appears in file name #${i}`);
        }
        if (file.content.includes(CONFORMANCE_HOOK_TOKEN)) {
          v.push(`${label}: the hook token appears in the content of ${JSON.stringify(file.name)}`);
        }
      });
    }
    argList.forEach((arg, i) => {
      if (arg.includes(CONFORMANCE_HOOK_TOKEN))
        v.push(`${label}: the hook token appears in args[${i}]`);
    });
    if (prompt !== undefined) {
      const count = argList.filter((arg) => arg === prompt).length;
      if (count !== 1) {
        v.push(`${label}: the prompt is ${count} argv elements unchanged, expected exactly 1`);
      }
    }
    for (const value of [...argList, ...envValues]) {
      if (worktreeForms.some((form) => value.includes(form))) {
        v.push(
          `${label}: ${JSON.stringify(value)} references the worktree (files go to sessionDir)`,
        );
      }
    }
  }
  return v;
}

export interface ConformanceCheck {
  name:
    | 'identity'
    | 'total'
    | 'events'
    | 'facts-only'
    | 'unknown-input'
    | 'tool-categories'
    | 'deterministic'
    | 'launch';
  title: string;
  run: (adapter: ProviderAdapter, options: ConformanceOptions) => string[];
}

export type ConformanceCheckName = ConformanceCheck['name'];

export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  {
    name: 'identity',
    title: 'id is a known provider, binary.command is a bare name, categories are ToolCategories',
    run: (adapter) => checkIdentity(adapter),
  },
  {
    name: 'total',
    title: 'normalize never throws and always returns an array',
    run: checkTotal,
  },
  {
    name: 'events',
    title:
      'every event parses and takes provider, sessionId, id and ts from the adapter and context',
    run: checkEvents,
  },
  {
    name: 'facts-only',
    title: 'events carry facts only: no health, severity, mood or attention field (hard rule 6)',
    run: checkFactsOnly,
  },
  {
    name: 'unknown-input',
    title: "unrecognized input yields 'unknown' events or nothing, never a throw (hard rule 7)",
    run: (adapter) => checkUnknownInput(adapter),
  },
  {
    name: 'tool-categories',
    title: "tool.category is toolCategories[tool.name], or 'other' for an unmapped name",
    run: checkToolCategories,
  },
  {
    name: 'deterministic',
    title: 'the same raw input and context give the same output',
    run: checkDeterministic,
  },
  {
    name: 'launch',
    title:
      'launch keeps the token in env only, files plain and in sessionDir, the prompt one argv element',
    run: (adapter) => checkLaunch(adapter),
  },
];

/** The violations one check finds; never throws. */
export function runConformanceCheck(
  name: ConformanceCheckName,
  adapter: ProviderAdapter,
  options: ConformanceOptions,
): string[] {
  const check = CONFORMANCE_CHECKS.find((c) => c.name === name);
  if (check === undefined) return [`no conformance check named ${name}`];
  try {
    return check.run(adapter, options).slice(0, MAX_MESSAGES);
  } catch (error) {
    return [`the ${name} check could not complete: ${describeError(error)}`];
  }
}

/** Every violation of every check, each prefixed with its check's name. */
export function conformanceViolations(
  adapter: ProviderAdapter,
  options: ConformanceOptions,
): string[] {
  return CONFORMANCE_CHECKS.flatMap((check) =>
    runConformanceCheck(check.name, adapter, options).map((message) => `${check.name}: ${message}`),
  );
}

/** Registers the conformance suite for one adapter: one `it` per check. */
export function describeConformance(
  name: string,
  makeAdapter: () => ProviderAdapter,
  options: ConformanceOptions,
): void {
  describe(`ProviderAdapter conformance: ${name}`, () => {
    it.each(CONFORMANCE_CHECKS)('$name: $title', ({ name: check }) => {
      expect(runConformanceCheck(check, makeAdapter(), options)).toEqual([]);
    });
  });
}
