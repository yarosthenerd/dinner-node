import { defineConfig } from 'vitest/config';

// Scoped to src/ only. Without this the root runner also collects web/, whose
// tests need a DOM environment and have their own config, and every file under
// node_modules.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
