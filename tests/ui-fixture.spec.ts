import { expect, test } from '@playwright/test';

/**
 * The shadcn primitives the site uses, held to DESIGN.md before any page depends on them.
 * Served by the dev server only (src/pages/dev/[fixture].astro); the production build has no such page.
 */

function luminance([r, g, b]: number[]) {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a: number[], b: number[]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
      await page.goto('/dev/ui');
      await expect(page.locator('[data-fixture]')).toBeVisible();
    });

    test('the table wraps instead of scrolling sideways', async ({ page }) => {
      const overflow = await page.locator('[data-slot="table-container"]').evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test('hydrates and does not overflow', async ({ page }) => {
      // Astro drops the island's `ssr` attribute once React has taken it over.
      await expect(page.locator('astro-island')).not.toHaveAttribute('ssr', /.*/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test('card, badge and alert match the DESIGN.md shapes and stay flat', async ({ page }) => {
      const shapes = await page.evaluate(() => {
        const style = (selector: string) => {
          const element = document.querySelector(selector)!;
          const cs = getComputedStyle(element);
          return { radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, border: cs.borderTopWidth, role: element.getAttribute('role') };
        };
        return { card: style('[data-slot="card"]'), badge: style('[data-slot="badge"]'), alert: style('[data-slot="alert"]') };
      });
      expect(shapes.card).toMatchObject({ radius: '6px', shadow: 'none', border: '1px' });
      expect(shapes.badge.radius).toBe('3px');
      expect(shapes.alert.radius).toBe('6px');
      expect(shapes.alert.role, 'a static callout is a note, not an assertive alert').toBe('note');
    });

    test('alert and table rules use the site border tokens, not currentColor', async ({ page }) => {
      const colors = await page.evaluate(() => {
        const resolve = (token: string) => {
          const probe = document.createElement('div');
          probe.style.borderTop = `1px solid var(${token})`;
          document.body.append(probe);
          const color = getComputedStyle(probe).borderTopColor;
          probe.remove();
          return color;
        };
        const border = (selector: string, side: 'Top' | 'Bottom' = 'Top') =>
          getComputedStyle(document.querySelector(selector)!)[`border${side}Color` as 'borderTopColor'];
        return {
          editorial: resolve('--editorial-border'),
          strong: resolve('--border-strong'),
          alert: border('[data-slot="alert"]'),
          headerRule: border('[data-slot="table-header"] [data-slot="table-row"]', 'Bottom'),
          bodyRule: border('[data-slot="table-body"] [data-slot="table-row"]', 'Bottom'),
        };
      });
      expect(colors.alert).toBe(colors.editorial);
      expect(colors.headerRule).toBe(colors.editorial);
      expect(colors.bodyRule).toBe(colors.strong);
    });

    test('text on every surface meets 4.5:1', async ({ page }) => {
      const failures = await page.evaluate(() => {
        const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const backgroundOf = (element: Element) => {
          for (let node: Element | null = element; node; node = node.parentElement) {
            const bg = getComputedStyle(node).backgroundColor;
            const alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3]) : 1;
            if (alpha > 0.5) return rgb(bg);
          }
          return rgb(getComputedStyle(document.body).backgroundColor);
        };
        return [...document.querySelectorAll('[data-fixture] :is(p, span, div, a, button, th, td, h2)')]
          .filter((element) => element.children.length === 0 && element.textContent?.trim())
          .map((element) => ({
            text: element.textContent!.trim().slice(0, 30),
            fg: rgb(getComputedStyle(element).color),
            bg: backgroundOf(element),
            size: parseFloat(getComputedStyle(element).fontSize),
          }));
      });
      expect(failures.length, 'the check found text to measure').toBeGreaterThan(10);
      const low = failures.filter((item) => ratio(item.fg, item.bg) < 4.5).map((item) => `${item.text} ${ratio(item.fg, item.bg).toFixed(2)}`);
      expect(low).toEqual([]);
    });

    test('standalone buttons are 44px and show a focus outline at once', async ({ page }) => {
      const buttons = page.locator('[data-fixture] [data-slot="button"]');
      const count = await buttons.count();
      expect(count).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const box = await buttons.nth(index).boundingBox();
        expect(box!.height, `button ${index} height`).toBeGreaterThanOrEqual(44);
        expect(box!.width, `button ${index} width`).toBeGreaterThanOrEqual(44);
      }
      await page.keyboard.press('Tab');
      await buttons.first().focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const focused = await buttons.first().evaluate((element) => {
        const cs = getComputedStyle(element);
        return { style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset, shadow: cs.boxShadow };
      });
      expect(focused).toMatchObject({ style: 'solid', width: '2px', offset: '3px', shadow: 'none' });
    });
  });
}
