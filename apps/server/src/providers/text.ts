// Small helpers adapters share for turning payload fields into event text.
import { scrubText } from '@micro-minds/shared';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or undefined. */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * One line (whitespace runs become one space), at most `max` characters, `…` when cut. Scrubbed
 * before the cut: a secret cut in half no longer matches the scrubber's patterns (hard rule 8).
 * The cut counts code points, so it never splits a surrogate pair.
 */
export function oneLine(value: string, max: number): string {
  const line = scrubText(value).replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}…`;
}
