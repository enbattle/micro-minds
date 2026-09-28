// Every severity threshold in one object (PLAN §6). reduce() takes it as a parameter, so a test or
// a user config can pass other values.

export interface Thresholds {
  /** The rolling window tool failures are counted in. */
  failureWindowMs: number;
  /** This many tool failures inside the window is a warning. */
  failuresForWarning: number;
  /** A working agent with no events for longer than this is "possibly stuck" (on clock.tick). */
  stuckAfterMs: number;
  /** Health goes back to ok this long after the last tool failure (on clock.tick). */
  recoveryAfterMs: number;
}

const MINUTE = 60_000;

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  failureWindowMs: 5 * MINUTE,
  failuresForWarning: 3,
  stuckAfterMs: 10 * MINUTE,
  recoveryAfterMs: 5 * MINUTE,
});
