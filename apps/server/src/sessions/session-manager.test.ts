// Task 2.6: SessionManager lifecycle (PLAN §5.5, D13, D21, D29, hard rules 10–12). Real node-pty
// runs the fake provider's CLI or the probe (probe-cli.test-helpers.ts) where only a real process
// can show the behavior (cwd, env, argv, exit codes, process trees); the in-memory PTY from
// `fakePtys()` (the manager's `spawn` seam) is used where every byte or call must be exact.
// Every repo and `$MICROMINDS_HOME` is a fresh temp dir. No real provider CLI ever runs (C14).
import fs from 'node:fs';
import path from 'node:path';
import { EVENT_SCHEMA_VERSION, parseAgentEvent, ULID_PATTERN } from '@micro-minds/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAdapter } from '../providers/fake/adapter.ts';
import { baseEnv, type HookServer, startHookServer } from '../providers/fake/cli.test-helpers.ts';
import { createProviderRegistry } from '../providers/registry.ts';
import type { LaunchContext } from '../providers/types.ts';
import {
  branchExists,
  entriesUnder,
  git,
  isInside,
  isRegistered,
  makeTempRoot,
  microMindsBranches,
  registeredWorktrees,
  removeTempRoot,
  samePath,
} from '../worktrees/worktree-manager.test-helpers.ts';
import { WorktreeError } from '../worktrees/worktree-manager.ts';
import {
  eventsOf,
  exitAllFakes,
  type FakePtys,
  fakePtys,
  filesUnder,
  type Harness,
  type HarnessOptions,
  isAlive,
  killAll,
  makeHarness,
  PROBE_PATH,
  probeAdapter,
  probeChildPid,
  probeInput,
  probeReport,
  refusal,
  reportPathFor,
  sleep,
  TEST_TIMEOUT_MS,
  testLookup,
  WAIT_MS,
  waitUntil,
} from './session-manager.test-helpers.ts';
import { SessionError } from './session-manager.ts';

const isWindows = process.platform === 'win32';

let h: Harness | undefined;
let fake: FakePtys | undefined;
let hookServer: HookServer | undefined;
/** Temp roots a test made besides the harness (removed after it). */
const extraRoots: string[] = [];

function setup(options: HarnessOptions): Harness {
  fake = options.fake;
  h = makeHarness(options);
  return h;
}

afterEach(async () => {
  exitAllFakes(fake);
  if (h !== undefined) {
    await killAll(h.manager);
    removeTempRoot(h.tmp);
  }
  await hookServer?.close();
  for (const root of extraRoots.splice(0)) removeTempRoot(root);
  h = undefined;
  fake = undefined;
  hookServer = undefined;
});

async function waitEnded(harness: Harness, id: string, ms: number = WAIT_MS): Promise<void> {
  await waitUntil(`session ${id} ended`, () => harness.manager.get(id)?.status === 'ended', ms);
}

function expectWorktreeKept(harness: Harness, worktreePath: string, branch: string): void {
  expect(fs.existsSync(worktreePath)).toBe(true);
  expect(isRegistered(harness.repo, worktreePath)).toBe(true);
  expect(branchExists(harness.repo, branch)).toBe(true);
}

/** Rough entropy of a random token from its alphabet: hex 4 bits a char, base64(url) 6. */
function tokenBits(token: string): number {
  const body = token.replace(/=+$/, '');
  if (/^[0-9a-fA-F]+$/.test(body)) return body.length * 4;
  if (/^[A-Za-z0-9+/_-]+$/.test(body)) return body.length * 6;
  return 0;
}

const SETTINGS = { name: 'settings.json', content: '{"hooks":{"probe":true}}\n' };

describe('SessionManager', { timeout: TEST_TIMEOUT_MS }, () => {
  describe('create (C1)', () => {
    it('issues a ULID id, creates the worktree, writes the launch files to the sessions dir and spawns the CLI in the worktree at the given size', async () => {
      const launches: LaunchContext[] = [];
      const harness = setup({
        registry: (reportDir) =>
          createProviderRegistry([
            probeAdapter({ reportDir, files: [SETTINGS], onLaunch: (ctx) => launches.push(ctx) }),
          ]),
        serverUrl: 'http://127.0.0.1:4317',
      });

      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        firstPrompt: 'first prompt',
        cols: 100,
        rows: 30,
      });

      expect(session.id).toMatch(ULID_PATTERN);
      expect(session.provider).toBe('fake');
      expect(session.status).toBe('running');
      expect(session.branch).toBe(`micro-minds/${session.id}`);
      expect(path.basename(session.worktreePath)).toBe(session.id);
      expect(isInside(harness.worktreesRoot, session.worktreePath)).toBe(true);
      expect(isRegistered(harness.repo, session.worktreePath)).toBe(true);
      expect(branchExists(harness.repo, session.branch)).toBe(true);
      expect(harness.manager.get(session.id)).toMatchObject({ id: session.id, status: 'running' });

      // The launch context the adapter saw.
      expect(launches).toHaveLength(1);
      const [ctx] = launches;
      expect(ctx?.sessionId).toBe(session.id);
      expect(ctx?.serverUrl).toBe('http://127.0.0.1:4317');
      expect(ctx?.firstPrompt).toBe('first prompt');
      expect(samePath(ctx?.worktreePath ?? '', session.worktreePath)).toBe(true);
      expect(samePath(ctx?.sessionDir ?? '', path.join(harness.sessionsRoot, session.id))).toBe(
        true,
      );

      // Launch files go to $MICROMINDS_HOME/sessions/<id>/, never into the worktree.
      const settingsFile = path.join(harness.sessionsRoot, session.id, SETTINGS.name);
      expect(fs.readFileSync(settingsFile, 'utf8')).toBe(SETTINGS.content);
      expect(entriesUnder(session.worktreePath).some((e) => e.endsWith(SETTINGS.name))).toBe(false);
      expect(git(session.worktreePath, ['status', '--porcelain', '--untracked-files=all'])).toBe(
        '',
      );

      // The CLI really runs in the worktree, at the given size, with the returned pid.
      const report = await probeReport(harness.reportDir, session.id);
      expect(samePath(report.cwd, session.worktreePath)).toBe(true);
      expect(report.columns).toBe(100);
      expect(report.rows).toBe(30);
      expect(session.pid).toBe(report.pid);
      expect(report.argv).toContain('first prompt');
    });

    it('emits one session.started for the root agent, from the spawn', async () => {
      const pty = fakePtys();
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
        fake: pty,
      });

      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        cols: 80,
        rows: 24,
      });

      await waitUntil(
        'session.started',
        () => eventsOf(harness.events, session.id, 'session.started').length > 0,
      );
      const started = eventsOf(harness.events, session.id, 'session.started');
      expect(started).toHaveLength(1);
      const [event] = started;
      expect(parseAgentEvent(event).ok).toBe(true);
      expect(event).toMatchObject({
        v: EVENT_SCHEMA_VERSION,
        sessionId: session.id,
        agentId: session.id,
        provider: 'fake',
        kind: 'session.started',
      });
      expect(event?.id).toMatch(ULID_PATTERN);
      expect(pty.ptys).toHaveLength(1);
      expect(eventsOf(harness.events, session.id, 'session.ended')).toHaveLength(0);
    });

    it('gives each session its own ULID and its own worktree', async () => {
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
        fake: fakePtys(),
      });
      const input = { provider: 'fake' as const, repoPath: harness.repo, cols: 80, rows: 24 };

      const a = await harness.manager.create(input);
      const b = await harness.manager.create(input);

      expect(a.id).not.toBe(b.id);
      expect(samePath(a.worktreePath, b.worktreePath)).toBe(false);
      expect(
        harness.manager
          .list()
          .map((s) => s.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
    });

    it.each([
      { name: 'zero columns', cols: 0, rows: 24 },
      { name: 'a non-integer size', cols: 80.5, rows: 24 },
      { name: 'an absurdly large size', cols: 100_000, rows: 24 },
    ])('refuses $name before creating a worktree', async ({ cols, rows }) => {
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
        fake: fakePtys(),
      });

      const error = await refusal(() =>
        harness.manager.create({ provider: 'fake', repoPath: harness.repo, cols, rows }),
      );

      expect(error.code).toBe('invalid_size');
      expect(harness.worktreeCreates()).toBe(0);
      expect(fake?.ptys).toHaveLength(0);
    });
  });

  describe('environment (C2)', () => {
    it('gives the PTY the inherited environment plus the launch env, the launch env winning', async () => {
      const pty = fakePtys();
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
        fake: pty,
        serverUrl: 'http://127.0.0.1:4317',
        env: {
          MM_TEST_INHERITED: 'inherited-7',
          MICROMINDS_URL: 'http://127.0.0.1:1/stale',
          PATH: 'mm-test-path',
        },
      });

      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        cols: 90,
        rows: 20,
      });

      const { options, file } = pty.only();
      const env = options.env ?? {};
      expect(env.MM_TEST_INHERITED).toBe('inherited-7');
      expect(env.PATH).toBe('mm-test-path');
      expect(env.MICROMINDS_URL).toBe('http://127.0.0.1:4317');
      expect(env.MICROMINDS_SESSION_ID).toBe(session.id);
      expect(env.MICROMINDS_PROVIDER).toBe('fake');
      expect(typeof env.MICROMINDS_HOOK_TOKEN).toBe('string');
      expect(samePath(options.cwd ?? '', session.worktreePath)).toBe(true);
      expect(options.cols).toBe(90);
      expect(options.rows).toBe(20);
      // The binary came from the registry's PATH lookup.
      const resolved = createProviderRegistry([fakeAdapter]).resolveBinary('fake', testLookup());
      expect(resolved.ok && samePath(file, resolved.path)).toBe(true);
    });

    it('the running fake CLI sees MICROMINDS_URL, MICROMINDS_SESSION_ID and MICROMINDS_HOOK_TOKEN and posts its hooks with them', async () => {
      hookServer = await startHookServer();
      const server = hookServer;
      const harness = setup({
        registry: () => createProviderRegistry([fakeAdapter]),
        serverUrl: server.url,
      });

      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        firstPrompt: 'hello fake',
        cols: 80,
        rows: 24,
      });

      await waitUntil('the fake CLI posted its scenario', () => server.received.length >= 1);
      for (const request of server.received) {
        expect(request.url).toContain(encodeURIComponent(session.id));
        const auth = request.headers.authorization ?? '';
        expect(auth.startsWith('Bearer ')).toBe(true);
        expect(
          await harness.manager.verifyHookToken(session.id, auth.slice('Bearer '.length)),
        ).toBe(true);
      }

      await harness.manager.write(session.id, '/exit\r');
      await waitEnded(harness, session.id);
      expect(harness.manager.get(session.id)).toMatchObject({
        status: 'ended',
        exitCode: 0,
        endReason: 'exit',
      });
    });

    it('the running CLI sees inherited variables and the launch env (probe)', async () => {
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
        serverUrl: 'http://127.0.0.1:4317',
        env: { ...baseEnv(), MM_TEST_INHERITED: 'inherited-7' },
      });

      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        cols: 80,
        rows: 24,
      });

      const report = await probeReport(harness.reportDir, session.id);
      expect(report.env.MM_TEST_INHERITED).toBe('inherited-7');
      expect(report.env.MICROMINDS_URL).toBe('http://127.0.0.1:4317');
      expect(report.env.MICROMINDS_SESSION_ID).toBe(session.id);
      expect(report.env.MICROMINDS_PROVIDER).toBe('fake');
      const token = report.env.MICROMINDS_HOOK_TOKEN ?? '';
      expect(await harness.manager.verifyHookToken(session.id, token)).toBe(true);
      expect(report.argv.some((arg) => arg.includes(token))).toBe(false);
    });
  });

  describe('hook tokens (C3)', () => {
    it('issues each session its own unguessable token, only through the PTY env', async () => {
      const launches: LaunchContext[] = [];
      const pty = fakePtys();
      const harness = setup({
        registry: (reportDir) =>
          createProviderRegistry([
            probeAdapter({ reportDir, files: [SETTINGS], onLaunch: (ctx) => launches.push(ctx) }),
          ]),
        fake: pty,
      });
      const input = { provider: 'fake' as const, repoPath: harness.repo, cols: 80, rows: 24 };

      const sessions = [
        await harness.manager.create(input),
        await harness.manager.create(input),
        await harness.manager.create(input),
      ];

      const tokens = launches.map((ctx) => ctx.hookToken);
      expect(new Set(tokens).size).toBe(3);
      sessions.forEach((session, i) => {
        const token = launches[i]?.hookToken ?? '';
        const spawned = pty.ptys[i];
        expect(launches[i]?.sessionId).toBe(session.id);
        expect(tokenBits(token)).toBeGreaterThanOrEqual(128);
        // A ULID has only 80 random bits.
        expect(token).not.toMatch(ULID_PATTERN);
        expect(token.includes(session.id)).toBe(false);
        expect(spawned?.options.env?.MICROMINDS_HOOK_TOKEN).toBe(token);
        const argv = [spawned?.file ?? '', ...(spawned?.args ?? [])];
        expect(argv.some((arg) => arg.includes(token))).toBe(false);
      });
      for (const file of filesUnder(harness.sessionsRoot)) {
        const content = fs.readFileSync(file, 'utf8');
        for (const token of tokens) {
          expect(content.includes(token)).toBe(false);
          expect(file.includes(token)).toBe(false);
        }
      }
      for (const line of harness.logs.lines) {
        for (const token of tokens) expect(line.includes(token)).toBe(false);
      }
    });

    interface Pair {
      idA: string;
      idB: string;
      tokenA: string;
      tokenB: string;
    }

    const UNKNOWN_ID = '01K6G5W0000000000000999999';

    it.each([
      { name: "A's token for A → accepted", pick: (p: Pair) => [p.idA, p.tokenA], ok: true },
      { name: "B's token for B → accepted", pick: (p: Pair) => [p.idB, p.tokenB], ok: true },
      { name: "A's token for B → refused", pick: (p: Pair) => [p.idB, p.tokenA], ok: false },
      { name: "B's token for A → refused", pick: (p: Pair) => [p.idA, p.tokenB], ok: false },
      {
        name: 'any token for an unknown session → refused',
        pick: (p: Pair) => [UNKNOWN_ID, p.tokenA],
        ok: false,
      },
      { name: 'an empty token → refused', pick: (p: Pair) => [p.idA, ''], ok: false },
      {
        name: 'the token with a character appended → refused',
        pick: (p: Pair) => [p.idA, `${p.tokenA}x`],
        ok: false,
      },
      {
        name: 'the token missing its last character → refused',
        pick: (p: Pair) => [p.idA, p.tokenA.slice(0, -1)],
        ok: false,
      },
      {
        name: 'the token with its last character changed → refused',
        pick: (p: Pair) => [p.idA, `${p.tokenA.slice(0, -1)}${p.tokenA.endsWith('A') ? 'B' : 'A'}`],
        ok: false,
      },
      {
        name: 'a same-length non-ASCII string (different byte length) → refused, no throw',
        pick: (p: Pair) => [p.idA, 'é'.repeat(p.tokenA.length)],
        ok: false,
      },
    ])('verifyHookToken: $name', async ({ pick, ok }) => {
      const launches: LaunchContext[] = [];
      const harness = setup({
        registry: (reportDir) =>
          createProviderRegistry([
            probeAdapter({ reportDir, onLaunch: (ctx) => launches.push(ctx) }),
          ]),
        fake: fakePtys(),
      });
      const input = { provider: 'fake' as const, repoPath: harness.repo, cols: 80, rows: 24 };
      const a = await harness.manager.create(input);
      const b = await harness.manager.create(input);
      const pair: Pair = {
        idA: a.id,
        idB: b.id,
        tokenA: launches[0]?.hookToken ?? 'missing-a',
        tokenB: launches[1]?.hookToken ?? 'missing-b',
      };
      const [sessionId = '', token = ''] = pick(pair);

      expect(await harness.manager.verifyHookToken(sessionId, token)).toBe(ok);
    });
  });

  describe('binary resolution (C4)', () => {
    it.each([
      {
        name: 'an unknown provider',
        provider: 'claude' as const,
        command: 'node',
        code: 'unknown_provider',
        mentions: 'claude',
      },
      {
        name: 'a provider whose binary is not on PATH',
        provider: 'fake' as const,
        command: 'mm-no-such-binary-26',
        code: 'binary_not_found',
        mentions: 'mm-no-such-binary-26',
      },
    ])(
      'refuses $name with a clear error before any worktree exists',
      async ({ provider, command, code, mentions }) => {
        const harness = setup({
          registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir, command })]),
          fake: fakePtys(),
        });

        const error = await refusal(() =>
          harness.manager.create({ provider, repoPath: harness.repo, cols: 80, rows: 24 }),
        );

        expect(error.code).toBe(code);
        expect(error.message).toContain(mentions);
        expect(harness.worktreeCreates()).toBe(0);
        expect(entriesUnder(harness.worktreesRoot)).toEqual([]);
        expect(microMindsBranches(harness.repo)).toEqual([]);
        expect(fake?.ptys).toHaveLength(0);
        expect(harness.events).toEqual([]);
        expect(harness.manager.list()).toEqual([]);
      },
    );

    describe('a .cmd shim (registry kind `cmd`)', () => {
      const HEADER = [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '',
      ];

      /** npm's cmd-shim for a node script (as in node_modules/.bin/*.cmd). */
      function nodeScriptShim(target: string): string {
        return [
          ...HEADER,
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          '  SET PATHEXT=%PATHEXT:;.JS;=;%',
          ')',
          '',
          `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
          '',
        ].join('\r\n');
      }

      /** npm's cmd-shim for a native executable. */
      function nativeShim(target: string): string {
        return [...HEADER, `"%dp0%\\${target}"   %*`, ''].join('\r\n');
      }

      function hardLinkOrCopy(from: string, to: string): void {
        try {
          fs.linkSync(from, to);
        } catch {
          fs.copyFileSync(from, to);
        }
      }

      /** Builds `<tmp>/shim-bin/mmshim.cmd` and its target; returns the bin dir. */
      function makeShim(tmp: string, kind: 'node-script' | 'native' | 'opaque', marker: string) {
        const bin = path.join(tmp, 'shim-bin');
        if (kind === 'node-script') {
          const pkg = path.join(bin, 'node_modules', 'mmshim');
          fs.mkdirSync(pkg, { recursive: true });
          fs.writeFileSync(
            path.join(pkg, 'cli.js'),
            [
              '// npm-style package entry: runs the script named by its first argument.',
              "const { pathToFileURL } = require('node:url');",
              'import(pathToFileURL(process.argv[2]).href);',
              '',
            ].join('\n'),
          );
          fs.writeFileSync(
            path.join(bin, 'mmshim.cmd'),
            nodeScriptShim('node_modules\\mmshim\\cli.js'),
          );
        } else if (kind === 'native') {
          const pkg = path.join(bin, 'node_modules', 'mmtool');
          fs.mkdirSync(pkg, { recursive: true });
          hardLinkOrCopy(process.execPath, path.join(pkg, 'mmtool.exe'));
          fs.writeFileSync(
            path.join(bin, 'mmshim.cmd'),
            nativeShim('node_modules\\mmtool\\mmtool.exe'),
          );
        } else {
          fs.mkdirSync(bin, { recursive: true });
          fs.writeFileSync(
            path.join(bin, 'mmshim.cmd'),
            ['@ECHO off', `echo ran> "${marker}"`, 'call "%~dp0\\elsewhere.bat" %*', ''].join(
              '\r\n',
            ),
          );
        }
        return bin;
      }

      /** Quotes, `&`, `%VAR%`, `^`, `|` and a line break: each one breaks under cmd.exe. */
      function hostilePrompt(marker: string): string {
        return `he said "hi" & echo INJECTED > "${marker}" & %OS% ^& | x\nsecond line`;
      }

      function shimAdapterRegistry(reportDir: string) {
        return createProviderRegistry([
          probeAdapter({
            reportDir,
            command: 'mmshim',
            args: (ctx, reportPath) => [PROBE_PATH, reportPath, '--', ctx.firstPrompt ?? ''],
          }),
        ]);
      }

      it.runIf(isWindows).each([
        { name: 'npm shim for a node script → runs `node <script>`', kind: 'node-script' as const },
        { name: 'npm shim for a native .exe → runs the .exe', kind: 'native' as const },
      ])(
        '(Windows only: .cmd shims exist there) $name, never cmd.exe; argv arrives intact',
        async ({ kind }) => {
          const shimRoot = makeTempRoot();
          extraRoots.push(shimRoot);
          const marker = path.join(shimRoot, 'injected.txt');
          const bin = makeShim(shimRoot, kind, marker);
          const lookup = testLookup([bin]);
          expect(shimAdapterRegistry(shimRoot).resolveBinary('fake', lookup)).toMatchObject({
            ok: true,
            kind: 'cmd',
          });
          const harness = setup({ registry: shimAdapterRegistry, lookup });
          const prompt = hostilePrompt(marker);

          const session = await harness.manager.create({
            provider: 'fake',
            repoPath: harness.repo,
            firstPrompt: prompt,
            cols: 80,
            rows: 24,
          });

          expect(session.status).toBe('running');
          const report = await probeReport(harness.reportDir, session.id);
          expect(report.argv).toEqual([reportPathFor(harness.reportDir, session.id), '--', prompt]);
          await sleep(300);
          expect(fs.existsSync(marker)).toBe(false);
        },
      );

      it.runIf(isWindows)(
        '(Windows only: .cmd shims exist there) a shim whose real target cannot be determined is refused with the reason, before any worktree, and never run',
        async () => {
          const shimRoot = makeTempRoot();
          extraRoots.push(shimRoot);
          const marker = path.join(shimRoot, 'ran.txt');
          const bin = makeShim(shimRoot, 'opaque', marker);
          const harness = setup({ registry: shimAdapterRegistry, lookup: testLookup([bin]) });

          const error = await refusal(() =>
            harness.manager.create({
              provider: 'fake',
              repoPath: harness.repo,
              firstPrompt: 'hi',
              cols: 80,
              rows: 24,
            }),
          );

          expect(error.code).toBe('unsupported_binary');
          expect(error.message).toMatch(/\.cmd|shim|cmd\.exe/i);
          await sleep(300);
          expect(fs.existsSync(marker)).toBe(false);
          expect(harness.worktreeCreates()).toBe(0);
          expect(harness.manager.list().filter((s) => s.status === 'running')).toEqual([]);
        },
      );
    });
  });

  describe('exit (C9)', () => {
    it.each([
      { name: 'exit 0 → ended, session.ended, no session.crashed', code: 0, crashed: false },
      { name: 'exit 3 → ended, session.crashed', code: 3, crashed: true },
    ])('$name; the worktree is kept', async ({ code, crashed }) => {
      const pty = fakePtys();
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
        fake: pty,
      });
      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        cols: 80,
        rows: 24,
      });

      pty.only().emitExit(code);
      await waitEnded(harness, session.id);

      expect(harness.manager.get(session.id)).toMatchObject({
        status: 'ended',
        exitCode: code,
        endReason: 'exit',
      });
      if (crashed) {
        await waitUntil(
          'session.crashed',
          () => eventsOf(harness.events, session.id, 'session.crashed').length > 0,
        );
        expect(eventsOf(harness.events, session.id, 'session.crashed')).toHaveLength(1);
      } else {
        await waitUntil(
          'session.ended',
          () => eventsOf(harness.events, session.id, 'session.ended').length > 0,
        );
        expect(eventsOf(harness.events, session.id, 'session.ended')).toHaveLength(1);
        expect(eventsOf(harness.events, session.id, 'session.crashed')).toHaveLength(0);
      }
      for (const event of harness.events) expect(parseAgentEvent(event).ok).toBe(true);
      expectWorktreeKept(harness, session.worktreePath, session.branch);
    });

    it('records the real exit code of a CLI that exits by itself', async () => {
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
      });
      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        cols: 80,
        rows: 24,
      });
      await probeReport(harness.reportDir, session.id);

      await harness.manager.write(session.id, 'exit 3\r');
      await waitEnded(harness, session.id);

      expect(harness.manager.get(session.id)).toMatchObject({
        status: 'ended',
        exitCode: 3,
        endReason: 'exit',
      });
      await waitUntil(
        'session.crashed',
        () => eventsOf(harness.events, session.id, 'session.crashed').length > 0,
      );
      expectWorktreeKept(harness, session.worktreePath, session.branch);
    });

    it("deletes the session's own launch files on exit, and nothing else", async () => {
      const pty = fakePtys();
      const files = [
        { name: 'settings.json', content: '{}\n' },
        { name: 'extra.txt', content: 'extra\n' },
      ];
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir, files })]),
        fake: pty,
      });
      const input = { provider: 'fake' as const, repoPath: harness.repo, cols: 80, rows: 24 };
      const ending = await harness.manager.create(input);
      const other = await harness.manager.create(input);
      const endingDir = path.join(harness.sessionsRoot, ending.id);
      const otherDir = path.join(harness.sessionsRoot, other.id);
      const bystander = path.join(endingDir, 'keep-me.txt');
      fs.writeFileSync(bystander, 'not a launch file\n');

      pty.ptys[0]?.emitExit(0);
      await waitEnded(harness, ending.id);
      await waitUntil('the launch files are deleted', () =>
        files.every((f) => !fs.existsSync(path.join(endingDir, f.name))),
      );

      expect(fs.readFileSync(bystander, 'utf8')).toBe('not a launch file\n');
      for (const f of files) {
        expect(fs.readFileSync(path.join(otherDir, f.name), 'utf8')).toBe(f.content);
      }
      expectWorktreeKept(harness, ending.worktreePath, ending.branch);
    });
  });

  describe('stop and kill (C10)', () => {
    it('kill ends the whole process tree at once (user_kill) and keeps the worktree', async () => {
      const harness = setup({
        registry: (reportDir) =>
          createProviderRegistry([probeAdapter({ reportDir, extraArgs: ['--spawn-child'] })]),
        stopGraceMs: 30_000,
      });
      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        cols: 80,
        rows: 24,
      });
      const report = await probeReport(harness.reportDir, session.id);
      const childPid = await probeChildPid(harness.reportDir, session.id);
      expect(isAlive(childPid)).toBe(true);

      const started = Date.now();
      await harness.manager.kill(session.id);
      await waitEnded(harness, session.id, 15_000);
      expect(Date.now() - started).toBeLessThan(15_000);

      await waitUntil(
        'the root and the child are dead',
        () => !isAlive(report.pid) && !isAlive(childPid),
        5_000,
      );
      expect(harness.manager.get(session.id)).toMatchObject({
        status: 'ended',
        endReason: 'user_kill',
      });
      expect(probeInput(harness.reportDir, session.id)).not.toContain('\x03');
      expect(eventsOf(harness.events, session.id, 'session.ended')).toHaveLength(1);
      expect(eventsOf(harness.events, session.id, 'session.crashed')).toHaveLength(0);
      expectWorktreeKept(harness, session.worktreePath, session.branch);
    });

    it('stop sends Ctrl-C, waits the grace period, then kills the whole tree (user_stop)', async () => {
      const graceMs = 1_500;
      const harness = setup({
        registry: (reportDir) =>
          createProviderRegistry([probeAdapter({ reportDir, extraArgs: ['--spawn-child'] })]),
        stopGraceMs: graceMs,
      });
      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        cols: 80,
        rows: 24,
      });
      const report = await probeReport(harness.reportDir, session.id);
      const childPid = await probeChildPid(harness.reportDir, session.id);

      const started = Date.now();
      await harness.manager.stop(session.id);
      await waitEnded(harness, session.id);

      // The probe ignores Ctrl-C, so only the kill after the grace period ends it.
      expect(Date.now() - started).toBeGreaterThanOrEqual(graceMs - 300);
      expect(probeInput(harness.reportDir, session.id)).toContain('\x03');
      await waitUntil(
        'the root and the child are dead',
        () => !isAlive(report.pid) && !isAlive(childPid),
        5_000,
      );
      expect(harness.manager.get(session.id)).toMatchObject({
        status: 'ended',
        endReason: 'user_stop',
      });
      expect(eventsOf(harness.events, session.id, 'session.crashed')).toHaveLength(0);
      expectWorktreeKept(harness, session.worktreePath, session.branch);
    });

    it('stop ends as soon as the CLI exits on Ctrl-C, without waiting out the grace period', async () => {
      const pty = fakePtys({ exitOnCtrlC: 130 });
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
        fake: pty,
        stopGraceMs: 30_000,
      });
      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        cols: 80,
        rows: 24,
      });

      const stopping = harness.manager.stop(session.id);
      await waitEnded(harness, session.id, 10_000);
      await stopping;

      const { writes } = pty.only();
      expect(writes.length).toBeGreaterThan(0);
      // Only Ctrl-C (once or more), nothing else.
      expect(writes.join('').replaceAll('\x03', '')).toBe('');
      expect(harness.manager.get(session.id)).toMatchObject({
        status: 'ended',
        endReason: 'user_stop',
      });
      await waitUntil(
        'session.ended',
        () => eventsOf(harness.events, session.id, 'session.ended').length > 0,
      );
      expect(eventsOf(harness.events, session.id, 'session.crashed')).toHaveLength(0);
      expectWorktreeKept(harness, session.worktreePath, session.branch);
    });
  });

  describe('failures (C11)', () => {
    const UNKNOWN = '01K6G5W0000000000000999999';

    it.each([
      { name: 'write', call: (m: Harness['manager'], id: string) => m.write(id, 'x') },
      { name: 'resize', call: (m: Harness['manager'], id: string) => m.resize(id, 80, 24) },
      { name: 'snapshot', call: (m: Harness['manager'], id: string) => m.snapshot(id) },
      { name: 'onOutput', call: (m: Harness['manager'], id: string) => m.onOutput(id, () => {}) },
      { name: 'stop', call: (m: Harness['manager'], id: string) => m.stop(id) },
      { name: 'kill', call: (m: Harness['manager'], id: string) => m.kill(id) },
    ])('$name on an unknown session id is refused with unknown_session', async ({ call }) => {
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
        fake: fakePtys(),
      });

      for (const id of [UNKNOWN, '../../not-a-session']) {
        const error = await refusal(() => call(harness.manager, id));
        expect(error.code).toBe('unknown_session');
      }
      expect(harness.manager.get(UNKNOWN)).toBeUndefined();
    });

    it.each([
      { name: 'the PTY spawn throws', throwOnSpawn: true, throwOnLaunch: false },
      { name: "the adapter's launch throws", throwOnSpawn: false, throwOnLaunch: true },
    ])(
      'when $name after the worktree exists: typed error, no running session, worktree kept',
      async ({ throwOnSpawn, throwOnLaunch }) => {
        const harness = setup({
          registry: (reportDir) =>
            createProviderRegistry([probeAdapter({ reportDir, throwOnLaunch })]),
          fake: fakePtys({ throwOnSpawn }),
        });

        await refusal(() =>
          harness.manager.create({ provider: 'fake', repoPath: harness.repo, cols: 80, rows: 24 }),
        );

        expect(harness.worktreeCreates()).toBe(1);
        expect(harness.manager.list().filter((s) => s.status === 'running')).toEqual([]);
        const worktrees = registeredWorktrees(harness.repo).filter(
          (p) => !samePath(p, harness.repo),
        );
        expect(worktrees).toHaveLength(1);
        expect(fs.existsSync(worktrees[0] ?? '')).toBe(true);
        expect(microMindsBranches(harness.repo)).toHaveLength(1);
        expect(harness.events.filter((e) => e.kind === 'session.started')).toEqual([]);
      },
    );

    it('refuses a repo path that is not a git repository with a typed error', async () => {
      const harness = setup({
        registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
        fake: fakePtys(),
      });
      const notARepo = path.join(harness.tmp, 'not-a-repo');
      fs.mkdirSync(notARepo);

      const outcome = await harness.manager
        .create({ provider: 'fake', repoPath: notARepo, cols: 80, rows: 24 })
        .then(
          () => 'resolved',
          (error: unknown) =>
            error instanceof SessionError || error instanceof WorktreeError ? 'typed' : 'untyped',
        );

      expect(outcome).toBe('typed');
      expect(harness.manager.list().filter((s) => s.status === 'running')).toEqual([]);
      expect(fake?.ptys).toHaveLength(0);
    });
  });

  describe('logging (C13)', () => {
    it('every line logged for a session carries its sessionId, and no line holds its token', async () => {
      const launches: LaunchContext[] = [];
      const pty = fakePtys();
      const harness = setup({
        registry: (reportDir) =>
          createProviderRegistry([
            probeAdapter({ reportDir, files: [SETTINGS], onLaunch: (ctx) => launches.push(ctx) }),
          ]),
        fake: pty,
      });
      const before = harness.logs.lines.length;

      const session = await harness.manager.create({
        provider: 'fake',
        repoPath: harness.repo,
        firstPrompt: 'log me',
        cols: 80,
        rows: 24,
      });
      pty.only().emitData('some output\r\n');
      await harness.manager.write(session.id, 'input\r');
      await harness.manager.resize(session.id, 100, 30);
      await harness.manager.snapshot(session.id);
      pty.only().emitExit(3);
      await waitEnded(harness, session.id);
      await sleep(100);

      const records = harness.logs.records().slice(before);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) expect(record.sessionId).toBe(session.id);
      const token = launches[0]?.hookToken ?? 'missing';
      for (const line of harness.logs.lines) expect(line.includes(token)).toBe(false);
    });
  });
});
