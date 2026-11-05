import { defineConfig } from 'vitest/config';

// Unit tests for the agent island's pure modules (src/lib/agent). Browser behaviour is covered by
// Playwright (tests/agent-island.spec.ts); the Worker has its own suite (worker/vitest.config.ts).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
