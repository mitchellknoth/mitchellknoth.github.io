import { expect, test, type Page } from '@playwright/test';

/**
 * Figure and diagram legibility (audit finding 11). DESIGN.md: genuine H2/H3 labels stay at least 20px, including
 * inside figures; supporting text 14px; metadata 12px. Labels are real text (not words inside an image file), and
 * no diagram escapes the column. The four Playwright projects (320, 768, 1440, 3440) run every test.
 *
 * Raster essay figures carry no words, so only text-bearing figures are measured here. The dark plate itself is
 * covered in article-components.spec.ts.
 */

const FIGURE_ROOTS = '.editorial-diagram, .article-figure, .cache-path, .execution-boundary, .request-path';

const PAGES = [
  '/writing/the-harness-should-not-live-on-your-laptop/',
  '/writing/the-model-is-table-stakes/',
  '/writing/done-is-a-claim-not-a-state/',
  '/writing/patch-outside-worker/',
  '/work/agentic-engineering/',
  '/work/secure-agent-execution/',
  '/work/bounded-runner/',
  '/how-this-works/',
];

type TextReport = { text: string; tag: string; size: number; mono: boolean; heading: boolean; selector: string };

/** Rendered size of every visible text node inside a figure, including SVG text scaled by its viewBox. */
async function readFigureText(page: Page): Promise<{ roots: number; text: TextReport[] }> {
  return page.evaluate((rootSelector) => {
    const roots = [...document.querySelectorAll(rootSelector)];
    const text: TextReport[] = [];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent?.trim();
        const element = node.parentElement;
        if (!value || !element) continue;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        // aria-hidden glyphs (step numbers, arrows) are decoration, not labels.
        if (element.closest('[aria-hidden="true"]')) continue;
        let size = parseFloat(style.fontSize);
        const svgText = element instanceof SVGElement ? (element.closest('text') as SVGGraphicsElement | null) : null;
        if (svgText) size *= svgText.getScreenCTM()?.a ?? 1;
        text.push({
          text: value.slice(0, 40),
          tag: element.tagName.toLowerCase(),
          size,
          mono: /mono/i.test(style.fontFamily),
          heading: /^H[1-6]$/.test(element.tagName),
          selector: `${element.tagName.toLowerCase()}.${String(element.getAttribute('class') ?? '').split(' ')[0]}`,
        });
      }
    }
    return { roots: roots.length, text };
  }, FIGURE_ROOTS);
}

for (const route of PAGES) {
  test(`figure text is legible at this width: ${route}`, async ({ page }) => {
    await page.goto(route);
    const { roots, text } = await readFigureText(page);
    expect(roots, 'the page has at least one figure or diagram').toBeGreaterThan(0);

    const tooSmall = text.filter((item) => {
      if (item.heading) return item.size < 20;
      if (item.mono) return item.size < 12;
      return item.size < 14;
    });
    expect(
      tooSmall.map((item) => `${item.selector} "${item.text}" ${item.size.toFixed(1)}px`),
      'headings 20px, supporting text 14px, mono metadata 12px, as rendered at this viewport',
    ).toEqual([]);
  });

  test(`no diagram escapes its column: ${route}`, async ({ page }) => {
    await page.goto(route);
    const viewport = page.viewportSize()!.width;
    const escapes = await page.evaluate(
      ({ rootSelector, viewport }) =>
        [...document.querySelectorAll(rootSelector)]
          .map((root) => {
            // A headed block keeps its H2 in the reading column and widens only the diagram inside it
            // (.editorial-wide), so the diagram is what must stay on screen.
            const diagram = root.querySelector('.editorial-wide') ?? root;
            const box = diagram.getBoundingClientRect();
            return {
              name: String(root.getAttribute('class')).split(' ').slice(0, 2).join('.'),
              scroll: diagram.scrollWidth - diagram.clientWidth,
              left: Math.round(box.left),
              right: Math.round(box.right),
            };
          })
          .filter((item) => item.scroll > 0 || item.left < 0 || item.right > viewport),
      { rootSelector: FIGURE_ROOTS, viewport },
    );
    expect(escapes, 'figures neither scroll sideways nor leave the viewport').toEqual([]);
  });
}

for (const [route, name] of [
  ['/writing/patch-outside-worker/', 'credential-boundary'],
  ['/writing/patch-outside-worker/', 'independent-validation'],
  ['/work/bounded-runner/', 'independent-validation'],
] as const) {
  test(`${name} diagram on ${route} is live text that never overlaps itself`, async ({ page }) => {
    await page.goto(route);
    const figure = page.locator(`.lab-diagram--${name}`);
    await expect(figure).toHaveCount(1);

    // Labels are selectable text in the document, not words inside an image file.
    await expect(figure.locator('img')).toHaveCount(0);
    for (const label of name === 'credential-boundary'
      ? ['Worker', 'Gateway', 'Fixture upstream', 'Synthetic token injected here', 'Internal network']
      : ['Worker', 'Host scope check', 'Validator', 'Receipt + patch', 'Frozen tests']) {
      await expect(figure.getByText(label, { exact: false }).first(), label).toBeVisible();
    }
    expect(await figure.evaluate((element) => getComputedStyle(element.querySelector('.lab-node__title')!).userSelect)).not.toBe('none');

    // The old credential diagram struck its connector label through at 320px; no two labels may share pixels.
    const overlaps = await figure.evaluate((element) => {
      const labels = [...element.querySelectorAll('.lab-node__title, .lab-node__detail, .lab-zone-label, .lab-feed__label, .lab-note, figcaption')];
      const boxes = labels.map((label) => ({ text: label.textContent!.trim().slice(0, 30), rect: label.getBoundingClientRect() }));
      const found: string[] = [];
      for (let first = 0; first < boxes.length; first += 1) {
        for (let second = first + 1; second < boxes.length; second += 1) {
          const a = boxes[first].rect;
          const b = boxes[second].rect;
          const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
          if (overlap) found.push(`${boxes[first].text} / ${boxes[second].text}`);
        }
      }
      return found;
    });
    expect(overlaps).toEqual([]);

    // Every label sits inside its own node, the plate, or the zone: nothing is clipped by overflow.
    const clipped = await figure.evaluate((element) =>
      [...element.querySelectorAll('.lab-node p')]
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => node.textContent!.trim().slice(0, 30)),
    );
    expect(clipped).toEqual([]);
  });
}

test('essay figure labels are not baked into an image file', async ({ page }) => {
  // Text-bearing figures are inline HTML. Only the raster artwork (which carries no words) stays an <img>.
  await page.goto('/writing/patch-outside-worker/');
  const sources = await page.locator('.article-figure img').evaluateAll((images) => images.map((image) => (image as HTMLImageElement).currentSrc));
  expect(sources.filter((source) => source.endsWith('.svg'))).toEqual([]);
});
