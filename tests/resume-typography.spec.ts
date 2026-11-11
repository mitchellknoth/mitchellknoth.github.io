import { expect, test, type Page } from '@playwright/test';
import { routes } from './support/routes';

// Headed review of the Résumé, Work index and case-study headers found three typography defects:
//   - the Résumé opened with a taller gap above its H1 than About and Work;
//   - at 320px a line could open with an en dash ("– From Requirements") or a separator dot ("· LinkedIn");
//   - the Résumé ranged dates and credentials with hyphens ("2026 - present") where the rest of the site uses en dashes.
// Each assertion reads the rendered page at the four viewport projects.

const caseRoutes = routes.filter((route) => route.startsWith('/work/') && route !== '/work/');

async function settle(page: Page, route: string) {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
}

/** Pixels from the bottom of the header rule to the top of the page's H1. */
async function gapAboveTitle(page: Page, route: string) {
  await settle(page, route);
  return page.evaluate(() => {
    const header = document.querySelector('.site-header');
    const title = document.querySelector('h1');
    if (!header || !title) throw new Error('missing header or h1');
    return title.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
  });
}

/**
 * For every element matching `selector`, the first visible character of each rendered line, read from Range rects
 * (one per character), so a line that opens with a dash or a separator dot is reported with the text it opens.
 */
async function lineOpeners(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const found: { text: string; line: string }[] = [];
    for (const element of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let lastTop = Number.NEGATIVE_INFINITY;
      let line = '';
      const flush = () => {
        if (line) found.push({ text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60), line });
        line = '';
      };
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent ?? '';
        for (let i = 0; i < value.length; i += 1) {
          if (/\s/.test(value[i])) continue; // spaces, including the no-break space
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          if (!rect || rect.height === 0) continue;
          if (rect.top - lastTop > rect.height / 2) {
            flush();
            lastTop = rect.top;
            line = value[i];
          } else {
            line += value[i];
          }
        }
      }
      flush();
    }
    return found.map(({ text, line }) => ({ text, opens: line.slice(0, 12) }));
  }, selector);
}

const opensWithPunctuation = (rows: { text: string; opens: string }[]) =>
  rows.filter((row) => /^[–—\-·•]/.test(row.opens)).map((row) => `${row.opens}… (in "${row.text}")`);

test('the Résumé title sits as far below the header as About and Work', async ({ page }) => {
  const resume = await gapAboveTitle(page, '/resume/');
  const about = await gapAboveTitle(page, '/about/');
  const work = await gapAboveTitle(page, '/work/');
  expect(Math.abs(resume - about), `resume ${resume}px, about ${about}px`).toBeLessThanOrEqual(8);
  expect(Math.abs(resume - work), `resume ${resume}px, work ${work}px`).toBeLessThanOrEqual(8);
});

test('no Work index title or date opens a line with a dash', async ({ page }) => {
  await settle(page, '/work/');
  const rows = await lineOpeners(page, 'main h3, main .mono-meta');
  expect(rows.length).toBeGreaterThan(5);
  expect(opensWithPunctuation(rows)).toEqual([]);
});

test('the Résumé link row and contact line never open a line with a dot or dash', async ({ page }) => {
  await settle(page, '/resume/');
  const rows = await lineOpeners(page, 'article.content > p, .resume-entry .mono-meta, article.content li');
  expect(rows.length).toBeGreaterThan(10);
  expect(opensWithPunctuation(rows)).toEqual([]);
});

for (const route of caseRoutes) {
  test(`${route} header and neighbour cards never open a line with a dash`, async ({ page }) => {
    await settle(page, route);
    const rows = await lineOpeners(page, 'article h1, header .mono-meta, .case-neighbour__title, .case-neighbour .mono-meta');
    expect(rows.length).toBeGreaterThan(1);
    expect(opensWithPunctuation(rows)).toEqual([]);
  });
}

test('the Résumé ranges dates and credentials with en dashes, as Work and About do', async ({ page }) => {
  await settle(page, '/resume/');
  const text = await page.evaluate(() => (document.querySelector('article.content')?.textContent ?? '').replace(/\u00a0/g, ' '));
  expect(text).toMatch(/2026 – present/);
  expect(text).toMatch(/Architect – Professional/);
  // A spaced hyphen is a range or a title separator written the wrong way; hyphenated words ("AI-assisted") are fine.
  expect(text.match(/\S+ - \S+/g) ?? []).toEqual([]);
});

// Headed-review defect 15: each experience entry printed "Cloud Software Engineer · John Deere" as its own line under
// its H2 and then the period as another line. The same role was repeated under all five entries, which was also wrong:
// the work moved through three teams as a Cloud Software Engineer, then a Software Engineer II and a Software Engineer I.
// Each entry now carries ONE meta line naming the role held, the employer, the team and the period together, so a chunk
// read alone (the agent corpus reads the Résumé entry by entry) stays attached to the right role, team and dates.
const experienceLines: Record<string, string> = {
  'AI-assisted delivery and developer platforms': 'Cloud Software Engineer · John Deere · SDLC-Next · 2026 – present',
  'Developer Experience': 'Cloud Software Engineer · John Deere · R2D2 – PR to Production · Late 2025 – early 2026',
  'Enterprise cloud foundations': 'Cloud Software Engineer · John Deere · Landing Zone · 2023 – 2025',
  'Digital equipment licensing': 'Software Engineer II · John Deere · License Management · 2021 – 2023',
  'External API platform': 'Software Engineer I · John Deere · Global Gateway · 2019 – 2021',
};

test('each Résumé experience entry carries role, employer, team and period in exactly one meta line', async ({ page }) => {
  await settle(page, '/resume/');
  const entries = await page.evaluate(() =>
    [...document.querySelectorAll('.resume-entry')].map((entry) => ({
      heading: (entry.querySelector('h2')?.textContent ?? '').trim(),
      metaLines: [...entry.querySelectorAll('.mono-meta')].map((line) => (line.textContent ?? '').replace(/\s+/g, ' ').trim()),
      // Paragraphs directly under the entry (not the meta line) that read as a bare role/employer line.
      barePrologue: [...entry.querySelectorAll(':scope > p:not(.mono-meta)')]
        .map((p) => (p.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((text) => /John Deere|Software Engineer/.test(text)),
    })),
  );
  expect(entries.map((entry) => entry.heading)).toEqual(Object.keys(experienceLines));
  for (const entry of entries) {
    expect(entry.metaLines, entry.heading).toEqual([experienceLines[entry.heading]]);
    expect(entry.barePrologue, entry.heading).toEqual([]);
  }
});

test('the merged Résumé meta line wraps only at its separators, never inside the role, employer, team or date range', async ({ page }) => {
  await settle(page, '/resume/');
  const rows = await lineOpeners(page, '.resume-entry .mono-meta');
  expect(rows.length).toBeGreaterThanOrEqual(5);
  // Every rendered line opens on the start of a unit (role, employer, team or period), never on the tail of one:
  // "Deere", "II", "Production", "early" or "present" would mean a unit split, and a dash or dot would open a line badly.
  const unitStart = /^(Cloud|Software|JohnDeere|SDLC|R2D2|Landing|License|Global|Late|\d{4})/;
  expect(rows.filter(({ opens }) => !unitStart.test(opens)).map(({ text, opens }) => `${opens} (in "${text}")`)).toEqual([]);
});
