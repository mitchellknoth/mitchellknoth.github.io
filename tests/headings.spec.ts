import { expect, test } from '@playwright/test';
import { routes } from './support/routes';

// DESIGN.md, Typography: one heading scale for the whole site, measured on the rendered page at each of the four
// viewport projects. `.content h1/h2/h3/p` once out-ranked Tailwind utilities, so a size asked for in markup
// (the Résumé title's `text-[40px]`) silently lost; this test reads computed styles, which is what the reader gets.
//
//   H1  clamp(2.5rem, 4vw, 3.5rem), line-height 1.08. Essay and case-study titles may reach 3.45rem and 3rem.
//   H2  clamp(1.6rem, 2.2vw, 2rem), serif, line-height 1.2.
//   H3  1.375rem Inter semibold, line-height 1.35; a diagram's own step labels may be as small as 20px.
//   No genuine H2/H3 under 20px, and the title outranks the section headings by at least 1.4x.

const TOLERANCE = 0.6; // px: sub-pixel rounding, and a scrollbar's width in `vw`

const pageTitleRoutes = new Set(['/', '/about/', '/resume/', '/work/', '/writing/', '/how-this-works/', '/this-route-should-not-exist/']);
const isEssay = (route: string) => route.startsWith('/writing/') && route !== '/writing/';
const isCase = (route: string) => route.startsWith('/work/') && route !== '/work/';

interface Heading {
  tag: string;
  text: string;
  size: number;
  lineHeight: number;
  family: string;
  weight: number;
}

for (const route of routes) {
  test(`${route} headings follow the DESIGN.md scale`, async ({ page }) => {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);

    const { viewport, headings } = await page.evaluate(() => ({
      viewport: window.innerWidth,
      headings: [...document.querySelectorAll<HTMLElement>('h1, h2, h3')]
        .filter((heading) => {
          const box = heading.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((heading) => {
          const style = getComputedStyle(heading);
          return {
            tag: heading.tagName,
            text: (heading.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 48),
            size: parseFloat(style.fontSize),
            lineHeight: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
            family: style.fontFamily,
            weight: Number(style.fontWeight),
          };
        }),
    }));

    const h1s = headings.filter((heading: Heading) => heading.tag === 'H1');
    const h2s = headings.filter((heading: Heading) => heading.tag === 'H2');
    const h3s = headings.filter((heading: Heading) => heading.tag === 'H3');

    // Exactly one H1, and it is the page title.
    expect(h1s, 'one H1 per page').toHaveLength(1);
    const [h1] = h1s;

    const h1Scale = Math.min(Math.max(2.5 * 16, 0.04 * viewport), 3.5 * 16);
    if (isEssay(route)) {
      // Long essay titles may reach 3.45rem but stay on the scale's floor.
      expect(h1.size, `${route} essay title`).toBeGreaterThanOrEqual(40 - TOLERANCE);
      expect(h1.size, `${route} essay title`).toBeLessThanOrEqual(3.45 * 16 + TOLERANCE);
    } else if (isCase(route)) {
      expect(h1.size, `${route} case-study title`).toBeGreaterThanOrEqual(40 - TOLERANCE);
      expect(h1.size, `${route} case-study title`).toBeLessThanOrEqual(3.5 * 16 + TOLERANCE);
    } else {
      expect(pageTitleRoutes.has(route), `${route} is a known page-title route`).toBe(true);
      expect(h1.size, `${route} page title is clamp(2.5rem, 4vw, 3.5rem)`).toBeCloseTo(h1Scale, 0);
    }
    expect(h1.lineHeight, 'H1 line-height 1.08–1.1').toBeGreaterThanOrEqual(1.08 - 0.005);
    expect(h1.lineHeight, 'H1 line-height 1.08–1.1').toBeLessThanOrEqual(1.1 + 0.005);
    expect(h1.family, 'H1 is the serif').toMatch(/Instrument Serif/);

    // H2: the scale's clamp, in the serif.
    const h2Scale = Math.min(Math.max(1.6 * 16, 0.022 * viewport), 2 * 16);
    for (const heading of h2s) {
      expect(heading.size, `H2 "${heading.text}" is clamp(1.6rem, 2.2vw, 2rem)`).toBeCloseTo(h2Scale, 0);
      expect(heading.family, `H2 "${heading.text}" is the serif`).toMatch(/Instrument Serif/);
      expect(heading.weight, `H2 "${heading.text}" is regular weight`).toBe(400);
    }

    // H3: 1.375rem Inter semibold; a diagram's step labels may be a little smaller but never under 20px.
    for (const heading of h3s) {
      expect(heading.size, `H3 "${heading.text}" is at most 1.375rem`).toBeLessThanOrEqual(22 + TOLERANCE);
    }
    // A diagram labels its own steps (20px, 21.6px); every H3 at the scale's 22px is the Inter semibold.
    const proseH3s = h3s.filter((heading: Heading) => heading.size >= 22 - 0.05);
    for (const heading of proseH3s) {
      expect(heading.family, `H3 "${heading.text}" is Inter`).toMatch(/Inter/);
      expect(heading.weight, `H3 "${heading.text}" is semibold`).toBeGreaterThanOrEqual(500);
    }

    // The floor holds everywhere, including inside figures, navigation and asides.
    for (const heading of [...h2s, ...h3s]) {
      expect(heading.size, `${heading.tag} "${heading.text}" is never under 20px`).toBeGreaterThanOrEqual(20);
    }

    // The title outranks the section headings it heads.
    const largestH2 = Math.max(0, ...h2s.map((heading: Heading) => heading.size));
    expect(h1.size, 'H1 is at least 1.4x the largest H2').toBeGreaterThanOrEqual(largestH2 * 1.4 - TOLERANCE);
  });
}

// A utility class asked for in markup has to win over the prose defaults: an article's summary sits a heading-to-copy
// distance below its title (DESIGN.md: 12–16px), and the Résumé title is not pushed down by a prose heading margin.
for (const route of ['/writing/patch-outside-worker/', '/work/team-brain/']) {
  test(`${route} title and summary keep a heading-to-copy gap`, async ({ page }) => {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    const gap = await page.evaluate(() => {
      const title = document.querySelector('header h1')!.getBoundingClientRect();
      const summary = document.querySelector('header h1 + p')!.getBoundingClientRect();
      return summary.top - title.bottom;
    });
    expect(gap, 'gap between the H1 and its summary').toBeGreaterThanOrEqual(12);
    expect(gap, 'gap between the H1 and its summary').toBeLessThanOrEqual(24);
  });
}

test('the Résumé title sits where the other page titles do, not under a prose heading margin', async ({ page }) => {
  await page.goto('/resume/', { waitUntil: 'domcontentloaded' });
  const [resumeTop, workTop] = [
    await page.locator('main h1').evaluate((heading) => heading.getBoundingClientRect().top),
    await page.goto('/work/', { waitUntil: 'domcontentloaded' }).then(() =>
      page.locator('main h1').evaluate((heading) => heading.getBoundingClientRect().top),
    ),
  ];
  expect(Math.abs(resumeTop - workTop), 'the same top offset as Work').toBeLessThanOrEqual(2);
});
