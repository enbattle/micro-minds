import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    // Never expose the dev server beyond this machine (PLAN §9.1).
    host: '127.0.0.1',
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    strictPort: true,
  },
  test: {
    name: 'web',
    environment: 'node',
    passWithNoTests: true,
  },
});
