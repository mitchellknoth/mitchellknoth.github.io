import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // tests/build/*.test.mjs are Node test-runner checks over dist/ (npm run test:build).
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4321',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1',
      url: 'http://127.0.0.1:4321',
      // Cloudflare's published always-pass Turnstile site key, so the island's widget flow runs in tests
      // (the script itself is mocked in tests/agent-island.spec.ts). The production key lives in the source.
      // PUBLIC_AGENT_ENABLED makes the island treat the agent as switched on, whatever wrangler.jsonc says, so
      // its live states can be exercised against mocked responses (the production build follows wrangler.jsonc).
      env: { PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA', PUBLIC_AGENT_ENABLED: 'true' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Serves the built dist/ for the egress contract (tests/egress.spec.ts); run `npm run build` first.
      command: 'npm run preview -- --host 127.0.0.1 --port 4322',
      url: 'http://127.0.0.1:4322',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The same site built with the agent switched on (PUBLIC_AGENT_ENABLED), for the test that proves the
      // production bundle hydrates and answers. dist/ follows wrangler.jsonc, where the agent is off, so it
      // can't show that. Run `npm run build:agent-on` first (npm run quality does); it builds into its own
      // folder, and nothing there is deployed. It is built before the run, not by this server, because a build
      // during the run makes the dev server reload mid-test.
      command: 'npm run preview -- --outDir dist-agent-on --host 127.0.0.1 --port 4323',
      url: 'http://127.0.0.1:4323',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Serves dist/ through the Workers static-assets config in wrangler.jsonc for the parity
      // contract (tests/workers-parity.spec.ts). Local only; nothing is deployed.
      command: 'npm run preview:workers',
      url: 'http://127.0.0.1:8787',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'phone',
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 844 } },
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'ultrawide',
      use: { ...devices['Desktop Chrome'], viewport: { width: 3440, height: 1440 } },
    },
  ],
});
