// Task 2.4, clause D7: the fake CLI, run for real as `node cli.ts` (argv array, no shell) against a
// loopback server this test starts on 127.0.0.1:0. It replays a fixtures/fake scenario to
// /hooks for the first prompt and for each stdin line, echoes stdin, and fails open.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFakeFixture } from '../replay.test-helpers.ts';
import {
  closedPort,
  type HookServer,
  type RunningCli,
  runCli,
  settle,
  startHookServer,
  TEST_TIMEOUT_MS,
  waitFor,
} from './cli.test-helpers.ts';

const SESSION = '01K6A2B3C4D5E6F7G8H9J0K1M2';
const TOKEN = 'mmhook-fake-cli-test-Hk4Lm6Np8Qr0St2';
const BASIC = loadFakeFixture('basic');
const SUBAGENT = loadFakeFixture('subagent');

const servers: HookServer[] = [];
const clis: RunningCli[] = [];
const tempDirs: string[] = [];

async function server(respond?: Parameters<typeof startHookServer>[0]): Promise<HookServer> {
  const s = await startHookServer(respond);
  servers.push(s);
  return s;
}

function cli(options: Parameters<typeof runCli>[0]): RunningCli {
  const c = runCli(options);
  clis.push(c);
  return c;
}

function envFor(url: string) {
  return { MICROMINDS_URL: url, MICROMINDS_SESSION_ID: SESSION, MICROMINDS_HOOK_TOKEN: TOKEN };
}

function bodies(s: HookServer): unknown[] {
  return s.received.map((r): unknown => JSON.parse(r.body));
}

afterEach(async () => {
  for (const c of clis.splice(0)) c.kill();
  for (const s of servers.splice(0)) await s.close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('fake CLI (D7)', { timeout: TEST_TIMEOUT_MS }, () => {
  it('the scenario fixtures exist and are non-empty', () => {
    expect(BASIC.length).toBeGreaterThan(0);
    expect(SUBAGENT.length).toBeGreaterThan(0);
  });

  it('replays basic for the first prompt: each line its own POST, in order, to hookEndpoint with the bearer token', async () => {
    const s = await server();
    const c = cli({ args: ['--', 'say hello'], env: envFor(s.url) });
    await waitFor(`${BASIC.length} posts`, () => s.received.length >= BASIC.length, c);
    expect(bodies(s)).toEqual(BASIC);
    for (const r of s.received) {
      expect(r.method).toBe('POST');
      const url = new URL(r.url, s.url);
      expect(url.pathname).toBe('/hooks');
      expect([...url.searchParams.keys()]).toEqual(['session']);
      expect(url.searchParams.get('session')).toBe(SESSION);
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.headers['content-type']).toMatch(/^application\/json\b/);
    }
    c.write('/exit');
    expect(await c.exit()).toBe(0);
    expect(s.received).toHaveLength(BASIC.length);
  });

  it('posts nothing before a prompt, then replays once per stdin line that is not /exit', async () => {
    const s = await server();
    const c = cli({ env: envFor(s.url) });
    await settle(750);
    expect(s.received).toHaveLength(0);
    c.write('first request');
    await waitFor('one replay', () => s.received.length >= BASIC.length, c);
    c.write('second request');
    await waitFor('two replays', () => s.received.length >= 2 * BASIC.length, c);
    expect(bodies(s)).toEqual([...BASIC, ...BASIC]);
    c.write('/exit');
    expect(await c.exit()).toBe(0);
    expect(s.received).toHaveLength(2 * BASIC.length);
  });

  it('echoes every stdin line back to stdout, in order', async () => {
    const s = await server();
    const c = cli({ env: envFor(s.url) });
    c.write('hello world');
    await waitFor('the first echo', () => c.lines().includes('hello world'), c);
    c.write('  second "line" & more  ');
    await waitFor('the second echo', () => c.lines().includes('  second "line" & more  '), c);
    const lines = c.lines();
    expect(lines.indexOf('hello world')).toBeLessThan(lines.indexOf('  second "line" & more  '));
    c.write('/exit');
    expect(await c.exit()).toBe(0);
  });

  it('/exit exits with code 0 and replays nothing for it', async () => {
    const s = await server();
    const c = cli({ env: envFor(s.url) });
    c.write('/exit');
    expect(await c.exit()).toBe(0);
    expect(s.received).toHaveLength(0);
  });

  it('the end of stdin exits with code 0', async () => {
    const s = await server();
    const c = cli({ args: ['--', 'go'], env: envFor(s.url) });
    await waitFor('the prompt replay', () => s.received.length >= BASIC.length, c);
    c.end();
    expect(await c.exit()).toBe(0);
  });

  it.each([
    { name: 'all three variables missing', env: {} },
    {
      name: 'the session id and token missing',
      env: { MICROMINDS_URL: 'SERVER' },
    },
    {
      name: 'the token missing',
      env: { MICROMINDS_URL: 'SERVER', MICROMINDS_SESSION_ID: SESSION },
    },
  ])('with $name it still echoes, posts nothing and exits 0', async ({ env }) => {
    const s = await server();
    const resolved = Object.fromEntries(
      Object.entries(env).map(([k, v]) => [k, v === 'SERVER' ? s.url : v]),
    );
    const c = cli({ args: ['--', 'say hello'], env: resolved });
    c.write('still here');
    await waitFor('the echo', () => c.lines().includes('still here'), c);
    c.end();
    expect(await c.exit()).toBe(0);
    expect(s.received).toHaveLength(0);
  });

  it('fails open against a closed port: keeps echoing and exits 0', async () => {
    const port = await closedPort();
    const c = cli({ args: ['--', 'say hello'], env: envFor(`http://127.0.0.1:${port}`) });
    c.write('after the refused posts');
    await waitFor('the echo', () => c.lines().includes('after the refused posts'), c);
    c.write('/exit');
    expect(await c.exit()).toBe(0);
  });

  it('fails open on a 500: the replay goes on through every line, and again for the next input', async () => {
    const s = await server(() => 500);
    const c = cli({ args: ['--', 'say hello'], env: envFor(s.url) });
    await waitFor('every line despite the 500s', () => s.received.length >= BASIC.length, c);
    c.write('again');
    await waitFor('the second replay', () => s.received.length >= 2 * BASIC.length, c);
    expect(bodies(s)).toEqual([...BASIC, ...BASIC]);
    c.write('/exit');
    expect(await c.exit()).toBe(0);
  });

  it('fails open on a timeout: a server that never answers the first POST does not stop the replay', async () => {
    const s = await server((n) => (n === 0 ? 'hang' : 200));
    const c = cli({ args: ['--', 'say hello'], env: envFor(s.url) });
    await waitFor('every line after the hung one', () => s.received.length >= BASIC.length, c);
    expect(bodies(s)).toEqual(BASIC);
    c.write('/exit');
    expect(await c.exit()).toBe(0);
  });

  it.each([
    { name: 'default (no --scenario) is basic', args: ['--', 'go'], expected: BASIC },
    { name: '--scenario basic', args: ['--scenario', 'basic', '--', 'go'], expected: BASIC },
    {
      name: '--scenario subagent',
      args: ['--scenario', 'subagent', '--', 'go'],
      expected: SUBAGENT,
    },
  ])('$name', async ({ args, expected }) => {
    const s = await server();
    const c = cli({ args, env: envFor(s.url) });
    await waitFor(`${expected.length} posts`, () => s.received.length >= expected.length, c);
    await settle(300);
    expect(bodies(s)).toEqual(expected);
    c.write('/exit');
    expect(await c.exit()).toBe(0);
  });

  it('finds the scenario relative to the script, not the working directory', async () => {
    const s = await server();
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'mm-fake-cli-'));
    tempDirs.push(cwd);
    const c = cli({ args: ['--', 'go'], env: envFor(s.url), cwd });
    await waitFor(`${BASIC.length} posts`, () => s.received.length >= BASIC.length, c);
    expect(bodies(s)).toEqual(BASIC);
    c.write('/exit');
    expect(await c.exit()).toBe(0);
  });

  it.each([
    { name: 'a path outside fixtures/fake', scenario: '../claude/qa' },
    { name: 'a Windows-style path', scenario: '..\\claude\\qa' },
    { name: 'upper case', scenario: 'BASIC' },
    { name: 'a dot', scenario: 'basic.jsonl' },
    { name: 'a scenario that does not exist', scenario: 'no-such-scenario' },
  ])(
    '--scenario with $name posts nothing, still echoes (fail open) and exits 0',
    async ({ scenario }) => {
      const s = await server();
      const c = cli({ args: ['--scenario', scenario, '--', 'go'], env: envFor(s.url) });
      c.write('probe');
      await waitFor('the echo', () => c.lines().includes('probe'), c);
      // Give a (wrong) replay of the first prompt and of `probe` time to reach the server.
      await settle(1_500);
      c.end();
      expect(await c.exit()).toBe(0);
      expect(s.received).toHaveLength(0);
    },
  );
});
