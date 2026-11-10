import { readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { expect, test } from '@playwright/test';

// The switched-off homepage (#18). With the agent off, the built island must show its notice and make no
// /agent request and no human check. On the live site the edge's Managed Challenge answers /agent/* first, so an
// island that still called the agent would show visitors a "verify you are human" box for a feature that is off.
// Runs against the built site (npm run build first), which follows wrangler.jsonc like production does.

const PREVIEW = 'http://127.0.0.1:4322';
const override = process.env.PUBLIC_AGENT_ENABLED;
const enabled =
  override === 'true' || override === 'false'
    ? override === 'true'
    : parseJsonc(readFileSync('wrangler.jsonc', 'utf8')).vars?.AGENT_ENABLED === 'true';

test.describe('with the agent switched off', () => {
  test.skip(enabled, 'AGENT_ENABLED is on, so the built island checks the agent.');
  test.skip(() => test.info().project.name !== 'desktop', 'The island does not depend on the viewport here.');

  test('the island shows its notice and makes no agent or human-check request', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));

    await page.goto(`${PREVIEW}/`);
    // The island has hydrated once Astro drops `ssr` from its wrapper; only then is "no request" a real result.
    await page.waitForFunction(() => document.querySelector('[data-agent-island]')?.closest('astro-island')?.hasAttribute('ssr') === false);
    await page.waitForLoadState('networkidle');

    const island = page.locator('[data-agent-island]');
    await expect(island).toHaveAttribute('data-state', 'offline');
    await expect(island.getByRole('status')).toContainText('The agent is switched off right now');
    await expect(island.getByRole('link', { name: 'Browse the work' })).toBeVisible();
    await expect(island.locator('textarea')).toHaveCount(0);

    expect(requested.filter((url) => new URL(url).pathname.startsWith('/agent/'))).toEqual([]);
    expect(requested.filter((url) => new URL(url).hostname === 'challenges.cloudflare.com')).toEqual([]);
    await expect(page.locator('iframe')).toHaveCount(0);
  });
});
