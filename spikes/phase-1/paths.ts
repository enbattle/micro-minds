// Shared constants for the Phase 1 spike (PLAN §10, task 1.1). Throwaway: Phase 2 reimplements
// what it needs and deletes spikes/.
//
// Everything the spike writes lives under ~/.micro-minds-dev/spike/, outside the repo: raw
// captures contain real paths, usernames and transcript paths, and only scrubbed copies (task 1.7)
// ever reach fixtures/claude/.

import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const SPIKE_DIR = path.join(homedir(), '.micro-minds-dev', 'spike');
export const CAPTURES_DIR = path.join(SPIKE_DIR, 'captures');
export const SETTINGS_DIR = path.join(SPIKE_DIR, 'settings');

export const SINK_HOST = '127.0.0.1';
export const DEFAULT_PORT = 47110;

export const CHANNELS = ['http', 'relay'] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

// Lowercase letters, digits and dashes only: a scenario name becomes a file name, so it must
// never contain a separator or `..`.
const SCENARIO_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function isScenario(value: unknown): value is string {
  return typeof value === 'string' && SCENARIO_PATTERN.test(value);
}

export function sinkPort(): number {
  const raw = process.env.SPIKE_SINK_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`SPIKE_SINK_PORT must be a port number, got "${raw}"`);
  }
  return port;
}

export function captureFile(capturesDir: string, scenario: string): string {
  return path.join(capturesDir, `${scenario}.jsonl`);
}
