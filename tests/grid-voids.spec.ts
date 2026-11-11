import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * Grid voids (headed review 2026-11, defects 3, 4 and 10): a grid row must not end in an empty cell where the
 * count allows another arrangement, a card's height must follow its content (no gap between a summary and its
 * tags created by stretching the card to its row), and the Home feature rule spans the shell like its neighbours.
 * Runs in the four viewport projects (320, 768, 1440, 3440).
 */

const slugs = (dir: string) => readdirSync(`src/content/${dir}`).map((file) => file.replace(/\.(md|mdx)$/, ''));
const routes = ['/', '/work/', '/writing/', ...slugs('posts').map((slug) => `/writing/${slug}/`), ...slugs('projects').map((slug) => `/work/${slug}/`)];

test.describe('grid rows end full', () => {
  for (const route of routes) {
    test(`${route}: no card or prose-list grid leaves an empty cell in its last row`, async ({ page }) => {
      const response = await page.goto(route);
      test.skip(!response?.ok(), 'unpublished route');
      const voids = await page.evaluate(() => {
        const found: string[] = [];
        for (const grid of document.querySelectorAll<HTMLElement>('main *')) {
          const style = getComputedStyle(grid);
          if (style.display !== 'grid' || grid.closest('[data-slot="card"]')) continue;
          const cells = [...grid.children].filter((child) => getComputedStyle(child).display !== 'none') as HTMLElement[];
          // Only grids of repeated items: list items or cards (a card may sit in a wrapper that stretches it).
          const repeated = cells.length >= 3 && cells.every((cell) => cell.tagName === 'LI' || cell.matches('[data-slot="card"]') || cell.querySelector(':scope > [data-slot="card"]'));
          if (!repeated) continue;
          const columns = style.gridTemplateColumns.split(' ').filter((track) => parseFloat(track) > 0.5).length;
          if (columns < 2) continue;
          const rects = cells.map((cell) => cell.getBoundingClientRect());
          const lastTop = Math.max(...rects.map((rect) => Math.round(rect.top)));
          const lastRow = rects.filter((rect) => Math.round(rect.top) === lastTop);
          const gap = parseFloat(style.columnGap) || 0;
          const filled = lastRow.reduce((sum, rect) => sum + rect.width, 0) + (lastRow.length - 1) * gap;
          if (filled < grid.getBoundingClientRect().width - 2) found.push(`${grid.tagName}.${grid.className.toString().slice(0, 40)}: ${cells.length} items, ${columns} columns, last row ${lastRow.length}`);
        }
        return found;
      });
      expect(voids, 'last row must fill the grid').toEqual([]);
    });
  }
});

test('Work: a card is as tall as its content, so tags follow the summary', async ({ page }) => {
  await page.goto('/work/');
  const gaps = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.work-card')].map((card) => {
      const summary = card.querySelector('p')!.getBoundingClientRect();
      const tags = card.querySelector('.work-card__foot [data-slot="badge"]')?.getBoundingClientRect();
      // A split (shell-wide) card sets the tags in a second column, beside the summary: no vertical gap to measure.
      const stacked = tags && tags.top >= summary.bottom - 1;
      return { title: card.querySelector('h3')!.textContent!.trim(), gap: stacked ? Math.round(tags.top - summary.bottom) : 0 };
    }),
  );
  for (const { title, gap } of gaps) expect(gap, `${title}: space between the summary and the tags`).toBeLessThanOrEqual(32);
});

test('Home: the Team Brain rule spans the shell like the section rules around it', async ({ page }) => {
  await page.goto('/');
  const ratio = await page.evaluate(() => document.querySelector('.decision-note')!.getBoundingClientRect().width / document.querySelector('main')!.getBoundingClientRect().width);
  expect(ratio, 'the feature rule runs the full width of the shell').toBeGreaterThan(0.97);
});
