import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs worker/test/*.test.ts inside workerd with the real wrangler.jsonc bindings. Nothing here calls the
// model: the tests stop every request before it reaches Workers AI, so they run offline and cost nothing.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)) },
      // Never open a remote session for the AI binding: tests stay offline and can't reach any Cloudflare
      // account a developer happens to be logged in to.
      remoteBindings: false,
      miniflare: {
        bindings: { AGENT_ENABLED: 'true' },
      },
    }),
  ],
  test: {
    include: ['worker/test/**/*.test.ts'],
  },
});
