import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engram layer is browser-bound: sessionStorage indexing semantics and
    // crypto.getRandomValues are the things under test, so it runs in jsdom
    // rather than node.
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
