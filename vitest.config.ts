import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'evals/harness', 'scripts'],
    // Only collected with `npm run test:coverage` (`vitest run --coverage`).
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage', // gitignored
      include: [
        'packages/*/src/**/*.ts',
        'apps/*/src/**/*.{ts,tsx}',
        '.claude/hooks/**/*.ts',
        'evals/harness/reviewer/*.ts',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.test-helpers.{ts,tsx}',
        '**/*.config.ts',
        // CLI entry point for the token-spending reviewer evals (`npm run eval:harness`). It
        // spawns Claude Code, so it is never unit-tested; its logic lives in the tested modules
        // next to it.
        'evals/harness/reviewer/run.ts',
      ],
      // No thresholds for apps/** or packages/hook-relay/** yet: hook-relay's entry runs in a
      // subprocess that v8 can't see, and app code arrives in Phases 2 and 3. The schedule for
      // adding them lives in docs/engineering-standards.md.
      thresholds: {
        'packages/shared/src/**': { lines: 95, functions: 95, statements: 95, branches: 90 },
        // Hook entry points (stdin → main) are marked `v8 ignore`: they run only in the subprocess
        // tests in evals/harness/guard, which v8 can't instrument. The logic is unit-tested.
        '.claude/hooks/**': {
          lines: 85,
          functions: 85,
          statements: 85,
          branches: 80,
        },
        'evals/harness/reviewer/*.ts': { lines: 80 },
      },
    },
  },
});
