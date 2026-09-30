// The Clock (D15, ADR 0015): time enters the reducer only as `clock.tick` events. While started,
// every interval it emits one tick per running session (the event schema needs a session; the
// reducer applies a tick to the whole world). Ticks go to subscribers, never to the store.
// Sleep/wake gap handling is task 2.11.
import { type AgentEvent, EVENT_SCHEMA_VERSION, type Provider } from '@micro-minds/shared';
import { newUlid } from '../ids.ts';
import type { Logger } from '../logging/logger.ts';

export const DEFAULT_TICK_INTERVAL_MS = 5_000;

export interface ClockTimers {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface ClockOptions {
  intervalMs?: number;
  sessions: {
    list: () => ReadonlyArray<{ id: string; provider: Provider; status: string }>;
  };
  onEvent: (event: AgentEvent) => void;
  now?: () => number;
  timers?: ClockTimers;
  /** Where a failing subscriber is reported. */
  logger?: Logger;
}

export interface Clock {
  start(): void;
  stop(): void;
}

const realTimers: ClockTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => {
    if (handle !== null && typeof handle === 'object') {
      clearInterval(handle as ReturnType<typeof setInterval>);
    }
  },
};

export function createClock(options: ClockOptions): Clock {
  const intervalMs = options.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  let handle: unknown;
  let running = false;

  function tick(): void {
    const ts = now();
    for (const session of options.sessions.list()) {
      if (session.status !== 'running') continue;
      // A throwing subscriber must neither escape the timer (an uncaught exception) nor cost the
      // other sessions their tick.
      try {
        options.onEvent({
          v: EVENT_SCHEMA_VERSION,
          id: newUlid(ts),
          ts,
          sessionId: session.id,
          provider: session.provider,
          agentId: session.id,
          kind: 'clock.tick',
        });
      } catch (error: unknown) {
        options.logger
          ?.child({ sessionId: session.id })
          .warn({ err: error }, 'a tick subscriber failed');
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      handle = timers.setInterval(tick, intervalMs);
    },
    stop() {
      if (!running) return;
      running = false;
      timers.clearInterval(handle);
      handle = undefined;
    },
  };
}
