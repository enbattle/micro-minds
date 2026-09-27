import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('./main.ts', import.meta.url));

describe('hook-relay (fail-open invariants)', () => {
  it('exits 0 and prints nothing when started outside micro-minds', () => {
    const result = spawnSync(process.execPath, [entry], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse' }),
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
