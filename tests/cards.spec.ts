import { expect, test } from '@playwright/test';

/**
 * Cards on the home, Work and Writing pages are shadcn Cards whose title link stretches over the whole card:
 * one tab stop and one accessible name per card, a card-wide click target, a card-level focus outline, and no
 * second "Read case study" link.
 */

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
    });

    test('Work: one link per case, no repeated "Read case study" links, the whole card is the target', async ({ page }) => {
      await page.goto('/work/');
      const cards = page.locator('.work-card');
      const count = await cards.count();
      expect(count).toBeGreaterThan(5);
      for (let index = 0; index < count; index += 1) {
        expect(await cards.nth(index).locator('a').count(), `card ${index} has one link`).toBe(1);
      }
      await expect(page.getByRole('link', { name: 'Read case study' })).toHaveCount(0);

      const first = cards.first();
      await first.scrollIntoViewIfNeeded();
      const box = (await first.boundingBox())!;
      await page.mouse.click(box.x + box.width - 8, box.y + Math.min(box.height - 8, 200));
      await expect(page).toHaveURL(/\/work\/[a-z-]+\/$/);
    });

    test('Work: the featured case is shell width, the rest sit in a grid with no per-row rules', async ({ page }) => {
      await page.goto('/work/');
      const layout = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.work-card')].map((card) => card.getBoundingClientRect());
        const width = document.querySelector('main')!.getBoundingClientRect().width;
        return { leadRatio: cards[0].width / width, viewport: document.documentElement.clientWidth, secondRow: cards.slice(1, 3).map((card) => Math.round(card.top)) };
      });
      expect(layout.leadRatio, 'the featured case spans the content width').toBeGreaterThan(0.95);
      if (layout.viewport >= 768) expect(layout.secondRow[0], 'compact cases sit side by side').toBe(layout.secondRow[1]);
    });

    test('card focus outlines the card, and hover steps the border up', async ({ page }) => {
      await page.goto('/writing/');
      const card = page.locator('[data-slot="card"]').filter({ has: page.locator('h3 a') }).first();
      await card.locator('a').focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const outline = await card.evaluate((element) => `${getComputedStyle(element).outlineStyle} ${getComputedStyle(element).outlineWidth}`);
      expect(outline).toBe('solid 2px');
      await page.mouse.move(0, 0);
      const rest = await card.evaluate((element) => getComputedStyle(element).borderTopColor);
      if (await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)) {
        await card.hover();
        await page.waitForTimeout(250);
        expect(await card.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(rest);
      }
    });

    test('Home proof cards and Writing cards navigate from anywhere on the card', async ({ page }) => {
      await page.goto('/');
      // On a host with no agent the island removes itself after its health check, which moves everything
      // below it; settle first so the card's position is final.
      await page.waitForFunction(() => !document.querySelector('[data-agent-island][data-state="loading"]'));
      const proof = page.locator('[data-slot="card"]').filter({ has: page.locator('h3 a') }).first();
      await proof.scrollIntoViewIfNeeded();
      const box = (await proof.boundingBox())!;
      await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10);
      await expect(page).toHaveURL(/\/work\/[a-z-]+\/$/);

      await page.goto('/writing/');
      const post = page.locator('[data-slot="card"]').filter({ has: page.locator('h3 a') }).first();
      await post.scrollIntoViewIfNeeded();
      const postBox = (await post.boundingBox())!;
      await page.mouse.click(postBox.x + postBox.width - 10, postBox.y + postBox.height - 10);
      await expect(page).toHaveURL(/\/writing\/[a-z-]+\/$/);
    });
  });
}
