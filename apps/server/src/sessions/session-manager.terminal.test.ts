// Task 2.6: the terminal side of a session (D16/ADR 0016, PLAN §8, hard rule 12, ADR 0019): the
// headless xterm and its snapshot, output batching, input, resize. Every PTY here is the
// in-memory `fakePtys()` passed as the manager's `spawn` seam, so each byte written to the PTY
// and each resize call is observed exactly. Snapshots are checked by replaying them into a fresh
// headless terminal, which is how a reconnecting browser repaints.
import { afterEach, describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../providers/registry.ts';
import { removeTempRoot } from '../worktrees/worktree-manager.test-helpers.ts';
import {
  bufferLines,
  exitAllFakes,
  type FakePtys,
  fakePtys,
  type Harness,
  type HarnessOptions,
  killAll,
  makeHarness,
  probeAdapter,
  refusal,
  replay,
  sleep,
  snapshotWhen,
  TEST_TIMEOUT_MS,
  waitUntil,
} from './session-manager.test-helpers.ts';

let h: Harness | undefined;
let fake: FakePtys | undefined;

afterEach(async () => {
  exitAllFakes(fake);
  if (h !== undefined) {
    await killAll(h.manager);
    removeTempRoot(h.tmp);
  }
  h = undefined;
  fake = undefined;
});

interface Started {
  harness: Harness;
  pty: FakePtys;
  id: string;
}

/** A manager on fake PTYs with one running session of the given size. */
async function started(
  size: { cols: number; rows: number } = { cols: 80, rows: 24 },
  options: Partial<HarnessOptions> = {},
  firstPrompt?: string,
): Promise<Started> {
  const pty = fakePtys();
  fake = pty;
  const harness = makeHarness({
    registry: (reportDir) => createProviderRegistry([probeAdapter({ reportDir })]),
    ...options,
    fake: pty,
  });
  h = harness;
  const session = await harness.manager.create({
    provider: 'fake',
    repoPath: harness.repo,
    ...(firstPrompt === undefined ? {} : { firstPrompt }),
    ...size,
  });
  return { harness, pty, id: session.id };
}

/** Collects a session's output deliveries. */
function collect(harness: Harness, id: string): { chunks: string[]; stop: () => void } {
  const chunks: string[] = [];
  const stop = harness.manager.onOutput(id, (data: string) => {
    chunks.push(data);
  });
  return { chunks, stop };
}

describe('SessionManager terminal', { timeout: TEST_TIMEOUT_MS }, () => {
  describe('headless xterm snapshot (C5)', () => {
    it('repaints the current screen, text and colors', async () => {
      const { harness, pty, id } = await started({ cols: 80, rows: 24 });

      pty.only().emitData('\x1b[2J\x1b[Hfirst line\r\nsecond \x1b[31mred\x1b[0m');
      const snapshot = await snapshotWhen(harness.manager, id, (s) => s.includes('red'));

      const terminal = await replay(snapshot, 80, 24);
      const lines = bufferLines(terminal);
      const firstRow = lines.indexOf('first line');
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lines[firstRow + 1]).toBe('second red');
      const cell = terminal.buffer.active.getLine(firstRow + 1)?.getCell(7);
      expect(cell?.getChars()).toBe('r');
      expect(cell?.isFgPalette()).toBe(true);
      expect(cell?.getFgColor()).toBe(1);
      terminal.dispose();
    });

    it('repaints an alt-screen app (the CLI UI) on the alternate buffer', async () => {
      const { harness, pty, id } = await started();

      pty.only().emitData('main screen\r\n\x1b[?1049h\x1b[H\x1b[2JALT-SCREEN');
      const snapshot = await snapshotWhen(harness.manager, id, (s) => s.includes('ALT-SCREEN'));

      const terminal = await replay(snapshot, 80, 24);
      expect(terminal.buffer.active.type).toBe('alternate');
      expect(bufferLines(terminal)[0]).toBe('ALT-SCREEN');
      terminal.dispose();
    });

    it('keeps a bounded scrollback: the oldest lines fall off', async () => {
      const scrollback = 500;
      const rows = 24;
      const { harness, pty, id } = await started({ cols: 80, rows }, { scrollback });
      const total = 5_000;
      const label = (n: number): string => `L${String(n).padStart(4, '0')}`;

      for (let start = 0; start < total; start += 500) {
        const block: string[] = [];
        for (let n = start; n < start + 500; n += 1) block.push(`${label(n)}\r\n`);
        pty.only().emitData(block.join(''));
      }
      const last = label(total - 1);
      const snapshot = await snapshotWhen(harness.manager, id, (s) => s.includes(last));

      const terminal = await replay(snapshot, 80, rows);
      const kept = bufferLines(terminal).filter((line) => /^L\d{4}$/.test(line));
      expect(kept).toContain(last);
      expect(kept).not.toContain(label(0));
      expect(kept.length).toBeLessThanOrEqual(scrollback + rows);
      terminal.dispose();
    });

    it.each([
      { name: 'DSR cursor position (ESC[6n)', query: '\x1b[6n' },
      { name: 'DSR status (ESC[5n)', query: '\x1b[5n' },
      { name: 'primary DA (ESC[c)', query: '\x1b[c' },
      { name: 'secondary DA (ESC[>c)', query: '\x1b[>c' },
      { name: 'DECRQM bracketed paste (ESC[?2004$p)', query: '\x1b[?2004$p' },
    ])(
      'the headless xterm never answers $name to the PTY; the query still reaches the browser',
      async ({ query }) => {
        const { harness, pty, id } = await started();
        const out = collect(harness, id);

        pty.only().emitData(`before${query}after-query`);
        await snapshotWhen(harness.manager, id, (s) => s.includes('after-query'));
        await waitUntil('the output with the query', () =>
          out.chunks.join('').includes('after-query'),
        );
        await sleep(150);

        expect(pty.only().writes).toEqual([]);
        expect(out.chunks.join('')).toContain(query);
      },
    );
  });

  describe('output (C6)', () => {
    it('batches a burst of small chunks into a few deliveries, in order, none lost or duplicated', async () => {
      const { harness, pty, id } = await started();
      const out = collect(harness, id);
      const sent: string[] = [];

      for (let i = 0; i < 500; i += 1) {
        const chunk = `c${i};`;
        sent.push(chunk);
        pty.only().emitData(chunk);
      }
      const expected = sent.join('');
      await waitUntil(
        'the whole burst',
        () => out.chunks.join('').length >= expected.length,
        2_000,
      );
      await sleep(100);

      expect(out.chunks.join('')).toBe(expected);
      expect(out.chunks.length).toBeLessThanOrEqual(5);
    });

    it('flushes within a short window when the output goes quiet', async () => {
      const { harness, pty, id } = await started();
      const out = collect(harness, id);

      pty.only().emitData('first');
      await waitUntil('the first chunk alone', () => out.chunks.join('') === 'first', 500);
      pty.only().emitData('second');
      await waitUntil('the second chunk', () => out.chunks.join('') === 'firstsecond', 500);

      expect(out.chunks.length).toBeGreaterThanOrEqual(2);
    });

    it('keeps order and loses nothing across many windows', async () => {
      const { harness, pty, id } = await started();
      const out = collect(harness, id);
      // A fixed, irregular pattern of pauses around the batching window.
      const pauses = [0, 3, 17, 1, 30, 0, 9, 16, 2, 25, 0, 5, 40, 1, 12, 0, 20, 4, 15, 8];
      const sent: string[] = [];

      for (const [i, pause] of pauses.entries()) {
        for (let j = 0; j < 7; j += 1) {
          const chunk = `<${i}.${j}>`;
          sent.push(chunk);
          pty.only().emitData(chunk);
        }
        await sleep(pause);
      }
      const expected = sent.join('');
      await waitUntil('everything', () => out.chunks.join('').length >= expected.length, 2_000);
      await sleep(100);

      expect(out.chunks.join('')).toBe(expected);
    });

    it('delivers output still pending when the CLI exits', async () => {
      const { harness, pty, id } = await started();
      const out = collect(harness, id);

      pty.only().emitData('last words');
      pty.only().emitExit(0);

      await waitUntil('the pending output', () => out.chunks.join('') === 'last words', 2_000);
    });

    it('delivers to every subscriber, and not after unsubscribing', async () => {
      const { harness, pty, id } = await started();
      const a = collect(harness, id);
      const b = collect(harness, id);

      pty.only().emitData('to both');
      await waitUntil(
        'both got it',
        () => a.chunks.join('') === 'to both' && b.chunks.join('') === 'to both',
      );
      a.stop();
      pty.only().emitData(' then b only');
      await waitUntil('b got more', () => b.chunks.join('') === 'to both then b only');
      await sleep(100);

      expect(a.chunks.join('')).toBe('to both');
    });

    it('a subscriber that throws neither escapes the manager nor starves the others (C11)', async () => {
      const { harness, pty, id } = await started();
      harness.manager.onOutput(id, () => {
        throw new Error('subscriber failed on purpose');
      });
      const out = collect(harness, id);

      pty.only().emitData('one');
      await waitUntil('one', () => out.chunks.join('') === 'one');
      pty.only().emitData(' two');
      await waitUntil('two', () => out.chunks.join('') === 'one two');
    });
  });

  describe('input (C7)', () => {
    it("writes the user's input to the session's PTY, byte for byte (a browser's query reply too)", async () => {
      const { harness, pty, id } = await started();

      await harness.manager.write(id, 'ls -la\r');
      await harness.manager.write(id, '\x1b[12;5R');

      expect(pty.only().writes.join('')).toBe('ls -la\r\x1b[12;5R');
    });

    it('never writes to the PTY on its own: not the first prompt, not on output, resize, snapshot or exit', async () => {
      const { harness, pty, id } = await started({ cols: 80, rows: 24 }, {}, 'do the thing');

      pty.only().emitData('Welcome\r\n\x1b[6n\x1b[c> ');
      await harness.manager.resize(id, 100, 30);
      await snapshotWhen(harness.manager, id, (s) => s.includes('Welcome'));
      await sleep(200);
      expect(pty.only().writes).toEqual([]);

      pty.only().emitExit(0);
      await sleep(200);
      expect(pty.only().writes).toEqual([]);
    });
  });

  describe('resize (C8)', () => {
    it.each([
      { name: 'small', cols: 20, rows: 5 },
      { name: 'large but sane', cols: 300, rows: 100 },
    ])('resizes the PTY ($name: $cols×$rows)', async ({ cols, rows }) => {
      const { harness, pty, id } = await started();

      await harness.manager.resize(id, cols, rows);

      expect(pty.only().resizes).toEqual([[cols, rows]]);
    });

    it('resizes the headless xterm too', async () => {
      const { harness, pty, id } = await started({ cols: 80, rows: 24 });

      await harness.manager.resize(id, 120, 50);
      // Column 100 and row 40 only exist after the resize; at 80×24 they clamp to 80 and 24.
      pty.only().emitData('\x1b[1;100HZ\x1b[40;1HR');
      const snapshot = await snapshotWhen(
        harness.manager,
        id,
        (s) => s.includes('Z') && s.includes('R'),
      );

      const terminal = await replay(snapshot, 200, 100);
      const lines = bufferLines(terminal);
      const zRow = lines.findIndex((line) => line.includes('Z'));
      expect(lines[zRow]?.indexOf('Z')).toBe(99);
      expect(lines.findIndex((line) => line.startsWith('R'))).toBe(zRow + 39);
      terminal.dispose();
    });

    it.each([
      { name: 'zero columns', cols: 0, rows: 24 },
      { name: 'zero rows', cols: 80, rows: 0 },
      { name: 'negative columns', cols: -1, rows: 24 },
      { name: 'non-integer rows', cols: 80, rows: 24.5 },
      { name: 'NaN', cols: Number.NaN, rows: 24 },
      { name: 'infinite columns', cols: Number.POSITIVE_INFINITY, rows: 24 },
      { name: 'absurdly many columns', cols: 100_000, rows: 24 },
      { name: 'absurdly many rows', cols: 80, rows: 100_000 },
    ])('refuses $name with invalid_size and leaves the PTY alone', async ({ cols, rows }) => {
      const { harness, pty, id } = await started();

      const error = await refusal(() => harness.manager.resize(id, cols, rows));

      expect(error.code).toBe('invalid_size');
      expect(pty.only().resizes).toEqual([]);
    });
  });
});
