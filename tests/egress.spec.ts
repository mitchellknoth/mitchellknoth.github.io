import { expect, test } from '@playwright/test';
import { isAllowedRequest } from './support/egress.mjs';
import { routes } from './support/routes';

// Runtime egress contract (#13): every page of the built site, served by `astro preview`, requests
// only its own origin. tests/build/egress.test.mjs checks the same rule statically over dist/.
const BUILT_SITE = 'http://127.0.0.1:4322';

for (const theme of ['dark', 'light']) {
  for (const route of routes) {
    test(`${theme} ${route} built page makes no third-party requests`, async ({ page }) => {
      test.skip(test.info().project.name !== 'desktop', 'Network egress does not depend on the viewport.');
      await page.addInitScript((theme) => localStorage.setItem('theme', theme), theme);

      const blocked: string[] = [];
      const fonts: string[] = [];
      await page.route('**/*', (intercepted) => {
        const request = intercepted.request();
        if (!isAllowedRequest(request.url(), BUILT_SITE)) {
          blocked.push(`${request.resourceType()} ${request.url()}`);
          return intercepted.abort('blockedbyclient');
        }
        if (request.resourceType() === 'font') fonts.push(request.url());
        return intercepted.continue();
      });
      page.on('websocket', (socket) => {
        if (!isAllowedRequest(socket.url(), BUILT_SITE)) blocked.push(`websocket ${socket.url()}`);
      });

      await page.goto(`${BUILT_SITE}${route}`, { waitUntil: 'load' });
      // Bring lazy images into view and let font loads settle before reading the log.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');

      expect(blocked).toEqual([]);
      expect(fonts.length, 'pages should load the self-hosted fonts').toBeGreaterThan(0);
    });
  }
}
