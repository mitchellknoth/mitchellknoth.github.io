import { expect, test, type Page } from '@playwright/test';

/**
 * Keyboard focus is one indicator, never two (DESIGN.md › Navigation and interaction: a 2px outline, offset 3px,
 * at least 3:1 against what it sits on).
 *
 * - A card that is one link carries the only ring: the stretched title link inside it draws no outline of its own.
 *   (The utility `focus-visible:outline-none` lost to the unlayered global `a:focus-visible` rule, so both drew.)
 * - A header control is one 2px outline: shadcn Button's own focus border (the thin inner line) and 3px halo are off.
 *
 * "In the focus path" means the focused element and every ancestor: exactly one of them may have an outline.
 */

type Probe = {
  tag: string;
  text: string;
  outlined: { tag: string; className: string; width: number; offset: number; style: string; contrast: number }[];
  /** The control's own border while focused, and after blur (its resting colour). They must match. */
  border: { focused: string; rest: string };
  boxShadow: string;
  height: number;
  width: number;
};

async function probeFocus(page: Page): Promise<Probe> {
  return page.evaluate(async () => {
    // Border colour transitions (0.15s); let focus settle before reading anything.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const channel = (value: number) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const backdrop = (element: Element | null) => {
      for (let node = element; node; node = node.parentElement) {
        const colour = rgba(getComputedStyle(node).backgroundColor);
        if (colour.a > 0.99) return colour;
      }
      return rgba(getComputedStyle(document.documentElement).backgroundColor);
    };

    const active = document.activeElement as HTMLElement;
    const outlined: Probe['outlined'] = [];
    for (let node: HTMLElement | null = active; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0) continue;
      const ring = rgba(style.outlineColor);
      const ground = backdrop(node.parentElement);
      const [lighter, darker] = [luminance(ring), luminance(ground)].sort((a, b) => b - a);
      outlined.push({
        tag: node.tagName.toLowerCase(),
        className: node.className?.toString() ?? '',
        width: parseFloat(style.outlineWidth),
        offset: parseFloat(style.outlineOffset),
        style: style.outlineStyle,
        contrast: (lighter + 0.05) / (darker + 0.05),
      });
    }
    const style = getComputedStyle(active);
    const box = active.getBoundingClientRect();
    // Only a border that is drawn counts: width 0 draws nothing whatever its colour.
    const drawn = () => {
      const now = getComputedStyle(active);
      return parseFloat(now.borderTopWidth) > 0 ? now.borderTopColor : 'none';
    };
    const focusedBorder = drawn();
    active.blur();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const restBorder = drawn();
    active.focus();
    return {
      tag: active.tagName.toLowerCase(),
      text: (active.textContent ?? '').trim().slice(0, 40),
      outlined,
      // shadcn Button draws `focus-visible:border-ring`: a thin inner line inside the outline.
      border: { focused: focusedBorder, rest: restBorder },
      boxShadow: style.boxShadow,
      height: box.height,
      width: box.width,
    };
  });
}

/** Moves focus to `locator`'s element the way a keyboard does (so :focus-visible matches). */
async function tabTo(page: Page, selector: string, index: number) {
  const target = page.locator(selector).nth(index);
  await target.scrollIntoViewIfNeeded();
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
}

function expectOneRing(probe: Probe, label: string, carrier?: string) {
  expect(probe.outlined.length, `${label}: exactly one outline in the focus path, got ${JSON.stringify(probe.outlined.map((o) => o.tag + '.' + o.className.slice(0, 30)))}`).toBe(1);
  const [ring] = probe.outlined;
  if (carrier) expect(ring.className, `${label}: the card carries the ring`).toContain(carrier);
  expect(ring.style, label).toBe('solid');
  expect(ring.width, `${label}: 2px`).toBe(2);
  expect(ring.offset, `${label}: 3px offset`).toBe(3);
  expect(ring.contrast, `${label}: >= 3:1 against what it sits on`).toBeGreaterThanOrEqual(3);
}

const cardPages = [
  { name: 'Home proof, featured case and writing cards', path: '/' },
  { name: 'Work cards', path: '/work/' },
  { name: 'Writing index cards', path: '/writing/' },
  { name: 'related-work card', path: '/writing/the-model-is-table-stakes/' },
  { name: 'previous/next case cards', path: '/work/team-brain/' },
];

for (const theme of ['dark', 'light'] as const) {
  for (const motion of ['no-preference', 'reduce'] as const) {
    test.describe(`${theme} theme, ${motion} motion`, () => {
      test.use({ reducedMotion: motion });
      test.beforeEach(async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
      });

      for (const { name, path } of cardPages) {
        test(`${name}: the card carries the only focus ring`, async ({ page }) => {
          await page.goto(path);
          const selector = '[data-slot="card"].card-link a';
          const count = await page.locator(selector).count();
          expect(count, `${path} has card links`).toBeGreaterThan(0);
          for (let index = 0; index < count; index += 1) {
            await tabTo(page, selector, index);
            const probe = await probeFocus(page);
            const label = `${path} card ${index} (${probe.text})`;
            expectOneRing(probe, label, 'card-link');
            expect(probe.border.focused, `${label}: no inner focus border on the title link`).toBe(probe.border.rest);
            expect(probe.boxShadow, `${label}: no ring halo`).toBe('none');
          }
        });
      }

      test('header controls draw one 2px outline, no inner border or halo, and stay 44px', async ({ page }) => {
        await page.goto('/work/');
        const seen: string[] = [];
        // Skip link, brand, Writing, Work, About, theme switch.
        for (let step = 0; step < 6; step += 1) {
          await page.keyboard.press('Tab');
          const probe = await probeFocus(page);
          const label = `header stop ${step} (${probe.text || probe.tag})`;
          seen.push(label);
          expectOneRing(probe, label);
          expect(probe.border.focused, `${label}: border does not change on focus (no inner ring)`).toBe(probe.border.rest);
          expect(probe.boxShadow, `${label}: no ring halo`).toBe('none');
          expect(probe.height, `${label}: at least 44px tall`).toBeGreaterThanOrEqual(44);
          expect(probe.width, `${label}: at least 44px wide`).toBeGreaterThanOrEqual(44);
        }
        expect(seen).toHaveLength(6);
      });
    });
  }
}
