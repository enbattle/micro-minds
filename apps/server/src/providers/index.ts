import { claudeAdapter } from './claude/adapter.ts';
import { fakeAdapter } from './fake/adapter.ts';
import { createProviderRegistry, type ProviderRegistry } from './registry.ts';

/** The providers the MVP ships: Claude, and the fake one for tests and CI (D10). */
export function createDefaultRegistry(): ProviderRegistry {
  return createProviderRegistry([claudeAdapter, fakeAdapter]);
}
