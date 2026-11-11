import { readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { expect, test } from '@playwright/test';

// The "how this works" page (#18). Layout, headings, overflow and both themes are covered with every
// other route by tests/site-quality.spec.ts; these checks cover what is specific to this page.

// Whether the agent is switched on is read the way the build reads it (src/lib/agent/enabled.ts): PUBLIC_AGENT_ENABLED
// if set, else AGENT_ENABLED in wrangler.jsonc. The expectations below follow that switch instead of recording
// today's deployment, so flipping it can't leave this test asserting stale copy.
const override = process.env.PUBLIC_AGENT_ENABLED;
const enabled =
  override === 'true' || override === 'false'
    ? override === 'true'
    : parseJsonc(readFileSync('wrangler.jsonc', 'utf8')).vars?.AGENT_ENABLED === 'true';
const BUILT_SITE = 'http://127.0.0.1:4322'; // dist/, built from the switch above
const AGENT_ON_BUILD = 'http://127.0.0.1:4323'; // dist-agent-on/, always built with the agent on

test('explains the agent in the sections the plan calls for', async ({ page }) => {
  await page.goto('/how-this-works/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How the agent on this site works');
  for (const section of ['The request path', 'What it can reach', 'Guardrails', 'How it fails', 'How I check its answers', 'Scorecard']) {
    await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
  }
  await expect(page.getByRole('figure', { name: /One origin, two lanes/ })).toBeVisible();
});

// The durable claim: the page says what the switch says, and never presents unscored work as scored.
// A page that still said "switched off" with the agent on (or the reverse) is the defect this guards.
async function expectStatusMatches(page: import('@playwright/test').Page, agentOn: boolean) {
  const status = page.getByRole('complementary', { name: 'Where it stands' });
  await expect(status).toContainText(agentOn ? 'The agent is switched on in production' : 'The agent is switched off in production');
  await expect(status).not.toContainText(agentOn ? 'switched off' : 'switched on');
  await expect(status).toContainText('nothing has been scored');
  await expect(status).toContainText('The question set is written and approved');
  // The failure list describes the switch itself, not a deployment state.
  const row = page.locator('.how-states').getByText('Switched off', { exact: true }).locator('xpath=..');
  await expect(row).toContainText('AGENT_ENABLED');
  await expect(row).not.toContainText('ships today');
}

test('the status follows the switch the build uses', async ({ page }) => {
  await page.goto(`${BUILT_SITE}/how-this-works/`);
  await expectStatusMatches(page, enabled);
});

test('a build with the agent on says so, whatever wrangler.jsonc holds', async ({ page }) => {
  await page.goto(`${AGENT_ON_BUILD}/how-this-works/`);
  await expectStatusMatches(page, true);
});

test('the scorecard is an honest empty state until eval results are committed', async ({ page }) => {
  await page.goto('/how-this-works/');
  const scorecard = page.locator('[data-eval-scorecard]');
  await expect(scorecard).toHaveAttribute('data-runs', '0');
  await expect(scorecard).toContainText('No scored runs are published yet.');
  // No invented figures: until a committed run supplies them, the page shows no percentages or scores.
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/\d\s*%|\b\d+\s*\/\s*\d+\b/);
});

test('the homepage island links to this page', async ({ page }) => {
  await page.route((url) => url.pathname === '/agent/health', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"state":"online"}' }),
  );
  await page.goto('/');
  await page.locator('[data-agent-island]').getByRole('link', { name: 'How it works' }).click();
  await expect(page).toHaveURL(/\/how-this-works\/$/);
});

// Geometry (headed review, defects 4b and 5). Runs in every viewport project (320, 768, 1440, 3440).
test('"Where it stands" is a reading-width component with supporting-text type', async ({ page }) => {
  await page.goto('/how-this-works/');
  const m = await page.evaluate(() => {
    const alert = document.querySelector('[data-slot="alert"]') as HTMLElement;
    const prose = document.querySelector('#request-path + p') as HTMLElement;
    const paras = [...alert.querySelectorAll('[data-slot="alert-description"] p')] as HTMLElement[];
    const cs = getComputedStyle(paras[0]);
    const last = getComputedStyle(paras[paras.length - 1]);
    return {
      alertWidth: alert.getBoundingClientRect().width,
      proseWidth: prose.getBoundingClientRect().width,
      fontSize: parseFloat(cs.fontSize),
      lineHeight: parseFloat(cs.lineHeight),
      lastMarginBottom: parseFloat(last.marginBottom),
      paddingTop: parseFloat(getComputedStyle(alert).paddingTop),
      paddingBottom: parseFloat(getComputedStyle(alert).paddingBottom),
      paragraphs: paras.length,
    };
  });
  // The same column as the prose around it, not a narrower box.
  expect(Math.abs(m.alertWidth - m.proseWidth)).toBeLessThanOrEqual(3);
  // DESIGN.md: supporting text is at least 14px at 1.6.
  expect(m.fontSize).toBeGreaterThanOrEqual(14);
  expect(m.lineHeight / m.fontSize).toBeGreaterThanOrEqual(1.55);
  // Broken into paragraphs, not one wall; no prose margin stacked on the padding under the last line.
  expect(m.paragraphs).toBeGreaterThanOrEqual(3);
  expect(m.lastMarginBottom).toBe(0);
  expect(Math.abs(m.paddingBottom - m.paddingTop)).toBeLessThanOrEqual(2);
});

test('Guardrails has no orphan cell and no card stretched past its text', async ({ page }) => {
  await page.goto('/how-this-works/');
  const cells = await page.evaluate(() => {
    const list = document.querySelector('#guardrails + ul') as HTMLElement;
    const listWidth = list.getBoundingClientRect().width;
    return [...list.children].map((li) => {
      const box = li.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(li);
      return { top: Math.round(box.top), width: box.width, height: box.height, textHeight: range.getBoundingClientRect().height, listWidth };
    });
  });
  expect(cells).toHaveLength(7);
  // Rows are groups of cards that share a top edge. A row either fills every column or is one card spanning the list.
  const rows = new Map<number, typeof cells>();
  for (const c of cells) rows.set(c.top, [...(rows.get(c.top) ?? []), c]);
  const columns = Math.max(...[...rows.values()].map((r) => r.length));
  for (const row of rows.values()) {
    const fullWidth = row.length === 1 && row[0].width >= row[0].listWidth - 2;
    expect(row.length === columns || fullWidth, `row at ${row[0].top} has ${row.length} of ${columns} cells`).toBe(true);
  }
  // A card is as tall as its own text plus padding. The list's baseline slack is under 40px; a card stretched to
  // its neighbour in the row showed 90–140px of empty space under the text.
  for (const c of cells) expect(c.height - c.textHeight, `card at ${c.top}`).toBeLessThanOrEqual(48);
});
