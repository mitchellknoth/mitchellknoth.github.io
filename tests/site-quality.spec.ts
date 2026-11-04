import { expect, test } from '@playwright/test';

const routes = [
  '/',
  '/about/',
  '/resume/',
  '/work/',
  '/writing/',
  '/work/agentic-engineering/',
  '/work/team-brain/',
  '/work/secure-agent-execution/',
  '/work/agent-trust/',
  '/work/bounded-runner/',
  '/work/pr-to-production/',
  '/work/onecloud-network/',
  '/work/vpc-deletion-automation/',
  '/work/license-management/',
  '/work/global-gateway/',
  '/writing/the-harness-should-not-live-on-your-laptop/',
  '/writing/the-model-is-table-stakes/',
  '/writing/done-is-a-claim-not-a-state/',
  '/writing/patch-outside-worker/',
  '/this-route-should-not-exist/',
];

for (const theme of ['dark', 'light']) {
  for (const route of routes) {
    test(`${theme} ${route} preserves the site visual contract`, async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts.ready);

      const geometry = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
        const brand = box('.site-brand');
        const nav = box('.site-header nav');
        const viewport = document.documentElement.clientWidth;
        const shell = box('.site-shell');

        return {
          viewport,
          overflow: document.documentElement.scrollWidth - viewport,
          shellWidth: shell?.width ?? 0,
          brandNavOverlap:
            brand && nav
              ? !(brand.right <= nav.left || nav.right <= brand.left || brand.bottom <= nav.top || nav.bottom <= brand.top)
              : false,
          h1Size: parseFloat(getComputedStyle(document.querySelector('h1')!).fontSize),
          bodySize: parseFloat(getComputedStyle(document.documentElement).fontSize),
          undersizedHeadings: [...document.querySelectorAll<HTMLElement>('main h2, main h3')]
            .filter((heading) => parseFloat(getComputedStyle(heading).fontSize) < 20)
            .map((heading) => heading.textContent?.trim()),
          escapedMedia: [...document.querySelectorAll<HTMLElement>('main img, main figure, main aside, main nav')]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.left < -1 || rect.right > viewport + 1;
            })
            .map((element) => element.className || element.tagName),
        };
      });

      expect(geometry.overflow, 'page must not scroll horizontally').toBeLessThanOrEqual(0);
      expect(geometry.brandNavOverlap, 'brand and primary navigation must not collide').toBe(false);
      expect(geometry.h1Size, 'the page title must be visually dominant').toBeGreaterThanOrEqual(
        geometry.bodySize * 1.75,
      );
      expect(geometry.undersizedHeadings, 'semantic section headings must not look like metadata').toEqual([]);
      expect(geometry.escapedMedia, 'visuals must remain within the viewport').toEqual([]);

      if (geometry.viewport >= 1200) {
        expect(geometry.shellWidth, 'wide layouts must use the viewport instead of a narrow fixed column').toBeGreaterThanOrEqual(1200);
        expect(geometry.shellWidth, 'wide layouts still need a readable maximum measure').toBeLessThanOrEqual(1440);
      }

      const directLists = page.locator('.content > ul, .content > ol');
      for (let index = 0; index < (await directLists.count()); index += 1) {
        const list = directLists.nth(index);
        const treatment = await list.locator(':scope > li').first().evaluate((item) => ({
          display: getComputedStyle(item).display,
          marker: getComputedStyle(item, '::before').content,
          markerDisplay: getComputedStyle(item, '::before').display,
          markerPosition: getComputedStyle(item, '::before').position,
        }));
        expect(treatment.display, 'prose list rows must use the editorial layout').toBe('block');
        expect(
          treatment.marker === 'none' || treatment.markerPosition === 'absolute',
          'list markers must be omitted or visually attached to their item',
        ).toBe(true);
        expect(
          treatment.markerDisplay === 'block' && treatment.markerPosition !== 'absolute',
          'list markers must not render as detached glyphs above each item',
        ).toBe(false);
      }

      if (geometry.viewport >= 1200 && route === '/writing/') {
        const featureComposition = await page.locator('.featured-post').evaluate((card) => {
          const cardBox = card.getBoundingClientRect();
          const childBoxes = [...card.children]
            .map((child) => child.getBoundingClientRect())
            .filter((box) => box.width > 0 && box.height > 0);
          const occupiedLeft = Math.min(...childBoxes.map((box) => box.left));
          const occupiedRight = Math.max(...childBoxes.map((box) => box.right));
          return (occupiedRight - occupiedLeft) / cardBox.width;
        });
        expect(
          featureComposition,
          'full-width feature panels must compose content across the available width',
        ).toBeGreaterThanOrEqual(0.75);
      }

      if (route === '/writing/') {
        await expect(
          page.locator('#writing-archive-title'),
          'the current publication list must not be mislabeled as an archive',
        ).toHaveText('More writing');
      }

      if (route.startsWith('/writing/') && route !== '/writing/') {
        const articleImages = page.locator('.article-figure img');
        expect(
          await articleImages.count(),
          'long-form essays must use at least two meaningful visual resets',
        ).toBeGreaterThanOrEqual(2);

        for (let index = 0; index < (await articleImages.count()); index += 1) {
          const image = articleImages.nth(index);
          const semantics = await image.evaluate((element) => ({
            alt: element.getAttribute('alt')?.trim() ?? '',
            width: element.getAttribute('width'),
            height: element.getAttribute('height'),
            loading: element.getAttribute('loading'),
          }));
          expect(semantics.alt, 'editorial visuals need descriptive alternative text').not.toBe('');
          expect(semantics.width, 'editorial visuals must reserve intrinsic width').toBeTruthy();
          expect(semantics.height, 'editorial visuals must reserve intrinsic height').toBeTruthy();
          if (index > 0) {
            expect(semantics.loading, 'later article visuals should not compete for initial load').toBe('lazy');
          }
        }
      }

      if (route === '/work/') {
        await expect(page.locator('.work-row')).not.toHaveCount(0);
        if (page.viewportSize()!.width === 320) {
          const title = await page.locator('.work-row h3').first().boundingBox();
          expect(title?.y, 'first case should be visible within the opening screen').toBeLessThanOrEqual(700);
        }
      }
      if (page.viewportSize()!.width < 768) {
        for (const caption of await page.locator('.comparison-table caption').all()) {
          const widthRatio = await caption.evaluate((node) => node.getBoundingClientRect().width / node.parentElement!.getBoundingClientRect().width);
          expect(widthRatio, 'stacked comparisons need full-width captions').toBeGreaterThanOrEqual(0.9);
        }
      }
      if (route === '/') {
        const action = await page.getByRole('link', { name: 'Explore my work' }).boundingBox();
        expect(action?.y, 'primary work route must appear in the first phone screen').toBeLessThan(800);
      }
      if (route.startsWith('/writing/') && route !== '/writing/') {
        const widths = await page.evaluate(() => {
          const article = document.querySelector('.article-layout')!.getBoundingClientRect().width;
          return [...document.querySelectorAll('.editorial-reading')].map((panel) => panel.getBoundingClientRect().width - article);
        });
        expect(widths.every((difference) => difference <= 1), 'reading panels must not inherit diagram width').toBe(true);
      }
      if (process.env.REVIEW_CAPTURE_DIR && !route.includes('this-route')) {
        await page.addStyleTag({ content: 'astro-dev-toolbar { display: none !important; }' });
        // Scroll through lazy images before accepting rendered review evidence.
        for (const image of await page.locator('main img').all()) {
          await image.scrollIntoViewIfNeeded();
          await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
          await image.evaluate((node) => (node as HTMLImageElement).decode());
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: `${process.env.REVIEW_CAPTURE_DIR}/${theme}-${page.viewportSize()!.width}-${route.replaceAll('/', '_')}.png`, fullPage: true });
      }
    });
  }
}

test('both themes preserve readable foreground and background tokens', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  for (const theme of ['dark', 'light']) {
    const colors = await page.evaluate((activeTheme) => {
      document.documentElement.dataset.theme = activeTheme;
      const style = getComputedStyle(document.documentElement);
      return { background: style.backgroundColor, foreground: style.color };
    }, theme);

    expect(colors.background).not.toBe(colors.foreground);
  }
});

test('hero portrait is static, small, and honors reduced motion', async ({ page }) => {
  await page.goto('/');
  const portrait = page.locator('.pixel-avatar__portrait');
  await expect(portrait).toBeVisible();
  const asset = await page.request.get('/images/mitch-portrait.webp');
  expect(asset.ok()).toBe(true);
  expect(asset.headers()['content-type']).toContain('image/webp');
  expect((await asset.body()).length).toBeLessThan(50_000);
  expect(await portrait.evaluate((node) => node.getAnimations().length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await portrait.evaluate((node) => node.getAnimations().length)).toBe(0);
});

for (const theme of ['dark', 'light']) {
  test(`${theme} standalone controls retain target size, state contrast, and keyboard focus`, async ({ page }) => {
    await page.addInitScript((theme) => {
      if (!localStorage.getItem('theme')) localStorage.setItem('theme', theme);
    }, theme);
    await page.goto('/');
    await page.addStyleTag({ content: 'astro-dev-toolbar { display: none !important; }' });
    const controls = page.locator('.site-brand, .nav-link, #theme-toggle, .footer-link, .standalone-link');
    for (const control of await controls.all()) {
      const bounds = await control.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
    }
    const contrast = async (selector: string, focus = false) => page.locator(selector).evaluate((element, focus) => {
      const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number).slice(0, 3);
      const luminance = (color: number[]) => color.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const style = getComputedStyle(element);
      const background = rgb(getComputedStyle(document.documentElement).backgroundColor);
      let opacity = 1;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        opacity *= Number(getComputedStyle(ancestor).opacity);
      }
      const foreground = rgb(focus ? style.outlineColor : style.color).map((channel, index) => channel * opacity + background[index] * (1 - opacity));
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    }, focus);
    for (const selector of ['.site-brand', '.nav-link', ...Array.from({ length: 4 }, (_, index) => `.footer-link:nth-child(${index + 1})`)]) {
      // The primary-nav selector identifies its first link; footer states are checked individually.
      const link = page.locator(selector).first();
      const uniqueSelector = selector === '.nav-link' ? '.nav-link:first-child' : selector;
      expect(await contrast(uniqueSelector)).toBeGreaterThanOrEqual(4.5);
      await link.hover();
      expect(await contrast(uniqueSelector)).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Tab');
      await link.focus();
      expect(await contrast(uniqueSelector)).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(uniqueSelector, true)).toBeGreaterThanOrEqual(3);
      expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
      await link.hover();
      await page.mouse.down();
      expect(await contrast(uniqueSelector)).toBeGreaterThanOrEqual(4.5);
      await page.mouse.move(0, 0);
      await page.mouse.up();
    }
    const toggle = page.locator('#theme-toggle');
    await expect(toggle).toHaveAccessibleName(theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    await toggle.click();
    await expect(toggle).toHaveAccessibleName(theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme');
    await page.getByRole('link', { name: 'Writing', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'dark' ? 'light' : 'dark');
    await expect(page.locator('#theme-toggle')).toHaveAccessibleName(theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme');
  });
}

for (const theme of ['dark', 'light']) {
  test(`${theme} reduced motion and coarse targets survive text spacing`, async ({ browser, page }) => {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:4321',
      viewport: page.viewportSize()!,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    try {
      await context.addInitScript((theme) => localStorage.setItem('theme', theme), theme);
      const reader = await context.newPage();
      for (const route of ['/', '/about/', '/work/', '/writing/', '/writing/the-harness-should-not-live-on-your-laptop/']) {
        await reader.goto(route);
        await reader.addStyleTag({ content: `
          astro-dev-toolbar { display: none !important; }
          main p, main li { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
          main p { margin-bottom: 2em !important; }
        ` });
        const measurements = await reader.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          coarse: matchMedia('(pointer: coarse)').matches,
          smallTargets: [...document.querySelectorAll('.nav-link, #theme-toggle, .footer-link, .standalone-link')].filter((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.width < 44 || bounds.height < 44;
          }).map((element) => element.textContent?.trim()),
        }));
        expect(measurements.coarse).toBe(true);
        expect(measurements.overflow).toBeLessThanOrEqual(0);
        expect(measurements.smallTargets).toEqual([]);
      }
    } finally {
      await context.close();
    }
  });
}
