import { expect, test } from '@playwright/test';

/**
 * The shell (header, nav, footer, inline links, theme switch) is built from shadcn Button variants
 * (src/lib/site-ui.ts, src/components/site/ThemeToggle.tsx). These checks cover what the variants must still
 * deliver on this site: colour and underline that survive the global `a` rule, a visible current page,
 * press feedback, and a theme switch that works, persists and respects reduced motion.
 */

const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number).join(',');

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
    });

    test('inline links are amber and underlined, nav is muted, the current page is amber', async ({ page }) => {
      await page.goto('/about/');
      const tokens = await page.evaluate(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const read = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const values = { accent: read('--accent'), muted: read('--fg-muted') };
        probe.remove();
        return values;
      });
      const link = page.locator('.fact-links [data-site="link"]').first();
      const linkStyle = await link.evaluate((element) => ({ color: getComputedStyle(element).color, line: getComputedStyle(element).textDecorationLine }));
      expect(rgb(linkStyle.color), 'a shadcn link is amber, not inherited').toBe(rgb(tokens.accent));
      expect(linkStyle.line).toContain('underline');

      const idle = await page.locator('[data-site="nav"]:not([aria-current])').first().evaluate((element) => getComputedStyle(element).color);
      expect(rgb(idle)).toBe(rgb(tokens.muted));
      const current = page.locator('[data-site="nav"][aria-current="page"]');
      await expect(current).toHaveText('About');
      expect(rgb(await current.evaluate((element) => getComputedStyle(element).color))).toBe(rgb(tokens.accent));
    });

    test('nav and links show a press state and one focus outline', async ({ page }) => {
      await page.goto('/');
      const nav = page.locator('[data-site="nav"]').first();
      const box = (await nav.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      const pressed = await nav.evaluate((element) => getComputedStyle(element).translate);
      await page.mouse.move(0, 0);
      await page.mouse.up();
      expect(pressed, 'shadcn nudges a pressed control by 1px').not.toBe('none');

      await nav.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const focus = await nav.evaluate((element) => {
        const style = getComputedStyle(element);
        return { outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}`, shadow: style.boxShadow };
      });
      expect(focus).toEqual({ outline: 'solid 2px 3px', shadow: 'none' });
    });

    test('the theme switch flips, names its action, persists across navigation and storage', async ({ page }) => {
      await page.goto('/');
      const toggle = page.locator('#theme-toggle');
      await expect(page.locator('astro-island', { has: toggle })).not.toHaveAttribute('ssr', /.*/);
      const first = theme === 'dark' ? 'light' : 'dark';
      await expect(toggle).toHaveAccessibleName(`Switch to ${first} theme`);
      await toggle.click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', first);
      await expect(toggle).toHaveAccessibleName(`Switch to ${theme} theme`);
      expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe(first);

      await page.locator('[data-site="nav"]', { hasText: 'About' }).click();
      await expect(page).toHaveURL(/\/about\/$/);
      await expect(page.locator('html')).toHaveAttribute('data-theme', first);
      await expect(page.locator('#theme-toggle')).toHaveAccessibleName(`Switch to ${theme} theme`);
    });
  });
}

test('with reduced motion the theme switch is a single frame', async ({ browser, page }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4321', viewport: page.viewportSize()!, reducedMotion: 'reduce' });
  try {
    await context.addInitScript(() => localStorage.setItem('theme', 'dark'));
    const reader = await context.newPage();
    await reader.goto('/');
    await reader.evaluate(() => {
      (window as unknown as { __vt: number }).__vt = 0;
      const original = document.startViewTransition?.bind(document);
      if (original) document.startViewTransition = (...args: Parameters<typeof original>) => {
        (window as unknown as { __vt: number }).__vt += 1;
        return original(...args);
      };
    });
    await reader.locator('#theme-toggle').click();
    await expect(reader.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await reader.evaluate(() => (window as unknown as { __vt: number }).__vt)).toBe(0);
  } finally {
    await context.close();
  }
});
