import { expect, test } from '@playwright/test';

// The "how this works" page (#18). Layout, headings, overflow and both themes are covered with every
// other route by tests/site-quality.spec.ts; these checks cover what is specific to this page.

test('explains the agent in the sections the plan calls for', async ({ page }) => {
  await page.goto('/how-this-works/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How the agent on this site works');
  for (const section of ['The request path', 'What it can reach', 'Guardrails', 'How it fails', 'How I check its answers', 'Scorecard']) {
    await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
  }
  const status = page.getByRole('complementary', { name: 'Where it stands' });
  // The page must not present the agent as live, or unscored work as scored.
  await expect(status).toContainText('The agent isn’t live');
  await expect(status).toContainText('nothing has been scored');
  await expect(page.getByRole('figure', { name: /One origin, two lanes/ })).toBeVisible();
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
