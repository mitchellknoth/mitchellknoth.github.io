import { expect, test, type Page } from '@playwright/test';

/**
 * Essay polish from the headed review (defects 1, 6, 7, 14). The four Playwright projects (320, 768, 1440, 3440)
 * run every test, in both themes where colour or elevation could change the result.
 *
 *  1. "← all writing" is the same eyebrow link as the case studies' "← all work": no hairline-and-radius box on
 *     its 44px hit region.
 *  7. A headed diagram block keeps its H2 and caption in the reading column and widens only the diagram.
 * 14. A figure plate's height follows its content (no void between the diagram and its caption).
 *  6. The essay kicker is a 3px tag, not a capsule, and wraps inside the column at 320.
 */

const ESSAYS = [
  '/writing/the-harness-should-not-live-on-your-laptop/',
  '/writing/the-model-is-table-stakes/',
  '/writing/done-is-a-claim-not-a-state/',
  '/writing/patch-outside-worker/',
];

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
    });

    for (const route of ESSAYS) {
      test(`the back link has no hairline box and keeps a 44px hit region: ${route}`, async ({ page }) => {
        await page.goto(route);
        const link = page.locator('article a[href="/writing/"]');
        await expect(link).toHaveCount(1);
        const look = await link.evaluate((a) => {
          const style = getComputedStyle(a);
          const box = a.getBoundingClientRect();
          return {
            // The button variant's 8px radius is shared with "← all work" and is invisible without a border or
            // fill; the defect was a border-bottom drawn along that radius under the 44px hit box.
            borders: ['Top', 'Right', 'Bottom', 'Left'].map((side) => {
              const borderStyle = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
              const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
              const color = style.getPropertyValue(`border-${side.toLowerCase()}-color`);
              return borderStyle !== 'none' && width > 0 && color !== 'transparent' && !/rgba\(.*, 0\)$/.test(color);
            }),
            background: style.backgroundColor,
            underline: style.textDecorationLine,
            height: box.height,
            width: box.width,
            eyebrow: a.classList.contains('eyebrow-link'),
            transform: style.textTransform,
            mono: /mono/i.test(style.fontFamily),
          };
        });
        expect(look.borders, 'no visible border on any side (top, right, bottom, left)').toEqual([false, false, false, false]);
        expect(look.background, 'no fill on the hit box').toBe('rgba(0, 0, 0, 0)');
        expect(look.underline, 'the underline is the persistent affordance').toContain('underline');
        expect(look.height, 'hit region stays 44px').toBeGreaterThanOrEqual(44);
        expect(look.width).toBeGreaterThanOrEqual(44);
        expect(look.eyebrow, 'same eyebrow-link treatment as the case studies').toBe(true);
        expect(look.transform).toBe('uppercase');
        expect(look.mono).toBe(true);
      });

      test(`the kicker is a 3px tag that stays inside the column: ${route}`, async ({ page }) => {
        await page.goto(route);
        const kicker = page.locator('.article-eyebrow');
        await expect(kicker).toHaveCount(1);
        const look = await kicker.evaluate((el) => {
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          const column = el.closest('article')!.getBoundingClientRect();
          return {
            radius: parseFloat(style.borderTopLeftRadius),
            left: box.left,
            right: box.right,
            columnLeft: column.left,
            columnRight: column.right,
            viewport: innerWidth,
            overflowX: el.scrollWidth - el.clientWidth,
            text: el.textContent!.replace(/\s+/g, ' ').trim(),
            // A line that opens with the separator reads as a stray dot: find any "·" at the left edge of a line.
            separatorOpensLine: (() => {
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              const inner = el.getBoundingClientRect().left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
              for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
                for (let i = 0; i < node.length; i += 1) {
                  if (node.data[i] !== '·') continue;
                  const range = document.createRange();
                  range.setStart(node, i);
                  range.setEnd(node, i + 1);
                  if (range.getBoundingClientRect().left - inner < 1) return true;
                }
              }
              return false;
            })(),
          };
        });
        expect(look.radius, 'DESIGN.md: tags are 3px, pills are for short status').toBeLessThanOrEqual(4);
        expect(look.overflowX, 'text wraps inside the tag').toBeLessThanOrEqual(1);
        expect(look.separatorOpensLine, 'a wrapped line never opens with the separator dot').toBe(false);
        expect(look.text, 'grouping must not change the kicker text').toMatch(/^[A-Za-z]+( [A-Za-z]+)*( · [A-Za-z]+( [A-Za-z]+)*)?$/);
        expect(look.left).toBeGreaterThanOrEqual(look.columnLeft - 0.5);
        expect(look.right).toBeLessThanOrEqual(look.columnRight + 0.5);
        expect(look.right).toBeLessThanOrEqual(look.viewport);
      });

      test(`a figure plate's height follows its content: ${route}`, async ({ page }) => {
        await page.goto(route);
        const figures = page.locator('article .article-figure');
        const count = await figures.count();
        expect(count).toBeGreaterThanOrEqual(1);
        for (let index = 0; index < count; index += 1) {
          await figures.nth(index).scrollIntoViewIfNeeded();
          const gaps = await figures.nth(index).evaluate((figure) => {
            const plate = figure.getBoundingClientRect();
            // Everything that paints on the plate, in document order: the picture, the diagram nodes and zone,
            // the note and the caption.
            const parts = [...figure.querySelectorAll<HTMLElement>('img, .lab-node, .lab-zone, .lab-note, figcaption')]
              .map((el) => el.getBoundingClientRect())
              .filter((box) => box.height > 0);
            const bottom = Math.max(...parts.map((box) => box.bottom));
            const top = Math.min(...parts.map((box) => box.top));
            // The diagram proper is what sits above the note or caption that explains it.
            const text = figure.querySelector<HTMLElement>('.lab-note, figcaption');
            const diagram = [...figure.querySelectorAll<HTMLElement>('.lab-node, .lab-zone, img')].map((el) => el.getBoundingClientRect());
            const diagramBottom = diagram.length ? Math.max(...diagram.map((box) => box.bottom)) : null;
            return {
              below: plate.bottom - bottom,
              above: top - plate.top,
              between: text && diagramBottom !== null && !figure.querySelector('img') ? text.getBoundingClientRect().top - diagramBottom : 0,
            };
          });
          expect(gaps.below, `plate ${index}: padding under its last content`).toBeLessThanOrEqual(24);
          expect(gaps.above, `plate ${index}: padding above its first content`).toBeLessThanOrEqual(32);
          expect(gaps.between, `plate ${index}: void between the diagram and its caption`).toBeLessThanOrEqual(36);
        }
      });
    }

    test('a headed diagram keeps its H2 and caption in the reading column, widening only the diagram', async ({ page }) => {
      const blocks = [
        { route: '/writing/the-model-is-table-stakes/', block: '.harness-map', diagram: 'ol', caption: 'header p' },
        { route: '/writing/the-harness-should-not-live-on-your-laptop/', block: '.harness-readiness', diagram: '.harness-readiness__matrix', caption: null },
      ];
      for (const { route, block, diagram, caption } of blocks) {
        await page.goto(route);
        const edges = await readEdges(page, block, diagram, caption);
        expect(edges.h2Left, `${route}: H2 starts at the prose edge`).toBeCloseTo(edges.proseLeft, 0);
        if (edges.captionLeft !== null) expect(edges.captionLeft, `${route}: caption starts at the prose edge`).toBeCloseTo(edges.proseLeft, 0);
        expect(edges.diagramLeft, `${route}: the diagram never starts right of the prose`).toBeLessThanOrEqual(edges.proseLeft + 0.5);
        expect(edges.diagramRight, `${route}: the diagram stays on screen`).toBeLessThanOrEqual(edges.viewport + 0.5);
        expect(edges.diagramLeft).toBeGreaterThanOrEqual(-0.5);
        if (edges.viewport >= 1024) {
          expect(edges.diagramWidth, `${route}: the diagram earns the wider measure`).toBeGreaterThan(edges.proseWidth + 100);
        }
        expect(edges.pageOverflow, `${route}: no horizontal page scroll`).toBeLessThanOrEqual(0);
      }
    });
  });
}

async function readEdges(page: Page, block: string, diagram: string, caption: string | null) {
  return page.evaluate(
    ({ block, diagram, caption }) => {
      const root = document.querySelector(block)!;
      const prose = document.querySelector('.content.article-layout > p')!;
      const proseBox = prose.getBoundingClientRect();
      const diagramBox = root.querySelector(diagram)!.getBoundingClientRect();
      const captionEl = caption ? root.querySelector(caption) : null;
      return {
        h2Left: root.querySelector('h2')!.getBoundingClientRect().left,
        captionLeft: captionEl ? captionEl.getBoundingClientRect().left : null,
        proseLeft: proseBox.left,
        proseWidth: proseBox.width,
        diagramLeft: diagramBox.left,
        diagramRight: diagramBox.right,
        diagramWidth: diagramBox.width,
        viewport: document.documentElement.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    },
    { block, diagram, caption },
  );
}
