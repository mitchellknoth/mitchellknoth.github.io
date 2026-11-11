import { expect, test } from '@playwright/test';
import { routes } from './support/routes';

/**
 * Case studies carry their proof: a facts block under the lede, and a previous/next pair at the end so a case is
 * not a dead end. The pair follows the order the Work page lists the cases (src/content `order`): the first case
 * has only a next link, the last only a previous one, every link is a real page, and no case links to itself.
 */
const cases = routes.filter((route) => /^\/work\/[a-z-]+\/$/.test(route));

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
    });

    for (const route of cases) {
      test(`${route} has a facts block, one previous/next pair of real pages, and no overflow at 320`, async ({ page, request }) => {
        await page.setViewportSize({ width: 320, height: 800 });
        await page.goto(route);

        const facts = page.getByRole('group', { name: 'Case at a glance' });
        await expect(facts).toBeVisible();
        const labels = await facts.locator('dt').allTextContents();
        expect(labels.slice(0, 3)).toEqual(['Context', 'Contribution', 'Result']);
        expect(labels.length).toBeLessThanOrEqual(4);
        for (const text of await facts.locator('dd').allTextContents()) expect(text.trim().length).toBeGreaterThan(20);
        // The block follows the lede and precedes the write-up.
        const order = await page.evaluate(() => {
          const lede = document.querySelector('article header p')!.getBoundingClientRect().top;
          const block = document.querySelector('.case-facts')!.getBoundingClientRect().top;
          const body = document.querySelector('article h2')!.getBoundingClientRect().top;
          return lede < block && block < body;
        });
        expect(order).toBe(true);

        const links = page.getByRole('navigation', { name: 'More case studies' }).getByRole('link');
        const hrefs = await links.evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).getAttribute('href')!));
        expect(hrefs.length, 'one link per neighbour, at most a pair').toBeGreaterThanOrEqual(1);
        expect(hrefs.length).toBeLessThanOrEqual(2);
        expect(new Set(hrefs).size, 'no duplicate links').toBe(hrefs.length);
        for (const href of hrefs) {
          expect(href).not.toBe(route);
          expect(cases, `${href} is a case study`).toContain(href);
          expect((await request.get(href)).status(), `${href} exists`).toBe(200);
        }
        const directions = await page.locator('.case-neighbour').evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.direction));
        if (route === '/work/agentic-engineering/') expect(directions).toEqual(['next']);
        else if (route === '/work/global-gateway/') expect(directions).toEqual(['previous']);
        else expect(directions).toEqual(['previous', 'next']);

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }

    test('the previous/next links walk the Work page order and each card is one stretched link', async ({ page }) => {
      await page.goto('/work/team-brain/');
      await page.locator('.case-neighbours').scrollIntoViewIfNeeded();
      const cards = page.locator('.case-neighbour');
      expect(await cards.count()).toBe(2);
      for (let index = 0; index < 2; index += 1) {
        expect(await cards.nth(index).locator('a').count(), 'one link per neighbour card').toBe(1);
        const card = (await cards.nth(index).boundingBox())!;
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href'), { x: card.x + card.width - 6, y: card.y + card.height - 6 });
        expect(hit, 'the whole card is the link target').toBe(await cards.nth(index).locator('a').getAttribute('href'));
      }
      await expect(cards.nth(0).locator('a')).toHaveAttribute('href', '/work/agentic-engineering/');
      await expect(cards.nth(1).locator('a')).toHaveAttribute('href', '/work/secure-agent-execution/');
      // A card title, not an inline prose link: no amber rule under it.
      expect(await cards.first().locator('a').evaluate((a) => getComputedStyle(a).borderBottomWidth)).toBe('0px');
    });

    test('the facts block is two columns from tablet width and one on a phone', async ({ page }) => {
      for (const [width, columns] of [[320, 1], [768, 2], [1440, 2]] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/work/team-brain/');
        const tops = await page.locator('.case-facts dl > div').evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().top)));
        expect(new Set(tops).size, `${width}px rows`).toBe(columns === 1 ? tops.length : tops.length / columns);
      }
    });

    test('the Bounded Execution Lab places the credential diagram beside the claim, lazy, with dimensions and alt text', async ({ page }) => {
      await page.goto('/work/bounded-runner/');
      const figure = page.locator('img[src$="credential-boundary.svg"]');
      await expect(figure).toHaveAttribute('loading', 'lazy');
      await expect(figure).toHaveAttribute('width', '1200');
      await expect(figure).toHaveAttribute('height', '640');
      expect(((await figure.getAttribute('alt')) ?? '').length).toBeGreaterThan(40);
      const placed = await figure.evaluate((img) => {
        const previous = img.closest('figure')!.previousElementSibling!;
        return previous.tagName === 'P' && /upstream token lives in the gateway environment/.test(previous.textContent ?? '');
      });
      expect(placed, 'the figure follows the gateway paragraph it explains').toBe(true);
    });
  });
}
