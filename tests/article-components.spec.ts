import { expect, test } from '@playwright/test';

/**
 * The article layer: essay figures are one dark plate in both themes, and the comparison table, field card,
 * lens panel and related-work card are shadcn Table and Card held to DESIGN.md.
 */

const ESSAY = '/writing/patch-outside-worker/';

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
    });

    test('essay figures are the same dark plate, caption included, in either theme', async ({ page }) => {
      await page.goto(ESSAY);
      const figures = page.locator('.article-figure');
      expect(await figures.count()).toBeGreaterThanOrEqual(2);
      for (let index = 0; index < (await figures.count()); index += 1) {
        const look = await figures.nth(index).evaluate((figure) => {
          const caption = figure.querySelector('figcaption')!;
          return { plate: getComputedStyle(figure).backgroundColor, caption: getComputedStyle(caption).color, captionBg: getComputedStyle(caption).backgroundColor };
        });
        expect(look.plate, 'the plate does not follow the theme').toBe('rgb(20, 17, 13)');
        expect(look.caption, 'the caption is light on the plate').toBe('rgb(187, 174, 152)');
        expect(look.captionBg).toBe('rgba(0, 0, 0, 0)');
      }
    });

    test('field card, lens panel and related-work card are 6px flat Cards with the editorial border', async ({ page }) => {
      for (const [route, selector] of [
        ['/writing/done-is-a-claim-not-a-state/', '.practice-card'],
        ['/writing/the-model-is-table-stakes/', '.framework-panel'],
        ['/writing/done-is-a-claim-not-a-state/', '.related-work'],
      ] as const) {
        await page.goto(route);
        const card = page.locator(selector).first();
        await expect(card, selector).toHaveAttribute('data-slot', 'card');
        const shape = await card.evaluate((element) => ({ radius: getComputedStyle(element).borderTopLeftRadius, shadow: getComputedStyle(element).boxShadow, role: element.getAttribute('role') }));
        expect(shape, selector).toEqual({ radius: '6px', shadow: 'none', role: 'complementary' });
      }
    });

    test('related-work is one link; the whole card navigates', async ({ page }) => {
      await page.goto('/writing/done-is-a-claim-not-a-state/');
      const card = page.locator('.related-work');
      expect(await card.locator('a').count()).toBe(1);
      await card.scrollIntoViewIfNeeded();
      const box = (await card.boundingBox())!;
      await page.mouse.click(box.x + box.width - 12, box.y + box.height - 12);
      await expect(page).toHaveURL(/\/(writing|work)\/[a-z-]+\/$/);
    });

    test('the comparison table is a real table on wide screens and stacked cards on phones, never scrolling sideways', async ({ page }) => {
      await page.goto('/writing/the-harness-should-not-live-on-your-laptop/');
      const table = page.locator('.comparison-table').first();
      await expect(table).toBeVisible();
      const width = page.viewportSize()!.width;
      const display = await table.evaluate((element) => getComputedStyle(element).display);
      expect(display).toBe(width < 768 ? 'block' : 'table');
      const overflow = await page.locator('[data-slot="table-container"]').first().evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (width >= 768) {
        expect(await table.locator('th[scope="col"]').count()).toBeGreaterThan(1);
        expect(await table.locator('th[scope="row"]').count()).toBeGreaterThan(1);
      }
    });

    test('case-study stack tags are Badges and still read as one list to the agent corpus', async ({ page }) => {
      await page.goto('/work/team-brain/');
      const tags = page.locator('[data-corpus-items] [data-slot="badge"]');
      expect(await tags.count()).toBeGreaterThan(2);
      expect(await tags.first().evaluate((element) => getComputedStyle(element).borderTopLeftRadius)).toBe('3px');
    });
  });
}
