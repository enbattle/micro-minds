import { defineProject } from 'vitest/config';

// Deterministic harness evals only (PLAN §11.1). Token-spending reviewer evals run via
// `npm run eval:harness`, never through Vitest or CI.
export default defineProject({
  test: {
    name: 'harness',
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
