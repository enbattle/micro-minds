/** Every provider the app knows about. Only `claude` and `fake` have adapters in the MVP (PLAN D10). */
export const PROVIDERS = ['claude', 'gemini', 'codex', 'fake'] as const;

export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}
