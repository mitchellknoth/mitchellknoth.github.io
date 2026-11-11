import { expect, test, type Page } from '@playwright/test';

// Headed review defect 8: About kept its H1, fact grid and prose flush to the shell's left edge, leaving the right
// third empty at 1440 and 3440, while the Résumé, case studies, essays and How this works centre one reading column.
// About now uses the same `content mx-auto` column, so the site has one left edge for reading pages.

async function settle(page: Page, route: string) {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
}

/** Left edge and width of the page's H1, and the Résumé-style reading column `article.content` around it. */
async function aboutGeometry(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null, name: string) => {
      if (!el) throw new Error(`missing ${name}`);
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    };
    const column = document.querySelector('main article.content');
    const grid = document.querySelector('main .fact-grid');
    const firstProse = document.querySelector('main article.content > section p, main article.content > p');
    const firstColumnItem = grid?.querySelector('div') ?? null;
    return {
      h1: rect(document.querySelector('main h1'), 'h1'),
      column: rect(column, 'article.content'),
      grid: rect(grid, '.fact-grid'),
      firstFact: rect(firstColumnItem, 'fact item'),
      prose: rect(firstProse, 'prose paragraph'),
      gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test('About H1, fact grid and prose share one left edge in the centred reading column', async ({ page }) => {
  await settle(page, '/about/');
  const g = await aboutGeometry(page);
  expect(Math.abs(g.h1.left - g.column.left), `h1 ${g.h1.left} vs column ${g.column.left}`).toBeLessThanOrEqual(1);
  expect(Math.abs(g.grid.left - g.column.left), `grid ${g.grid.left} vs column ${g.column.left}`).toBeLessThanOrEqual(1);
  expect(Math.abs(g.firstFact.left - g.column.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(g.prose.left - g.column.left), `prose ${g.prose.left} vs column ${g.column.left}`).toBeLessThanOrEqual(1);
  // The fact grid fills the column rather than a wider box than the prose beside it.
  expect(g.grid.width).toBeLessThanOrEqual(g.column.width + 1);
});

test('About reading column matches the Résumé column', async ({ page }) => {
  const column = () =>
    page.evaluate(() => {
      const r = document.querySelector('main article.content')?.getBoundingClientRect();
      if (!r) throw new Error('missing article.content');
      return { left: r.left, width: r.width };
    });
  await settle(page, '/about/');
  const about = await column();
  await settle(page, '/resume/');
  const resume = await column();
  expect(Math.abs(about.width - resume.width), `about ${about.width}px, resume ${resume.width}px`).toBeLessThanOrEqual(3);
  expect(Math.abs(about.left - resume.left), `about ${about.left}px, resume ${resume.left}px`).toBeLessThanOrEqual(3);
});

test('About fact grid is one column on phones and two from tablet, with no horizontal overflow', async ({ page }, testInfo) => {
  await settle(page, '/about/');
  const g = await aboutGeometry(page);
  expect(g.gridColumns).toBe(testInfo.project.name === 'phone' ? 1 : 2);
  expect(g.overflow).toBeLessThanOrEqual(0);
});
