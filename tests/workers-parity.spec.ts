import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test } from '@playwright/test';

// Workers parity contract (#15): the Workers static-assets config in wrangler.jsonc must serve every
// file in dist/ byte-for-byte, keep the directory-style URLs, and return dist/404.html with a 404.
// Locally it runs against `wrangler dev` (see playwright.config.ts). To check a deployment of the
// same build, set WORKERS_BASE_URL, e.g. the workers.dev URL, and run:
//   WORKERS_BASE_URL=https://<worker>.<subdomain>.workers.dev npx playwright test workers-parity --project desktop
const BASE = process.env.WORKERS_BASE_URL ?? 'http://127.0.0.1:8787';
const DIST = 'dist';

const CONTENT_TYPES: Record<string, string[]> = {
  html: ['text/html'],
  css: ['text/css'],
  js: ['text/javascript', 'application/javascript'],
  pdf: ['application/pdf'],
  png: ['image/png'],
  svg: ['image/svg+xml'],
  webp: ['image/webp'],
  woff2: ['font/woff2'],
  xml: ['application/xml', 'text/xml'],
  zip: ['application/zip'],
};

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

const files = listFiles(DIST).map((path) => relative(DIST, path).split(sep).join('/'));

// The URL a visitor uses for each built file: about/index.html is /about/, 404.html has no URL of its own.
function urlFor(file: string): string | null {
  if (file === '404.html') return null;
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file}`;
}

test.describe('Workers static assets match dist/', () => {
  test.skip(() => test.info().project.name !== 'desktop', 'Serving does not depend on the viewport.');

  test('dist/ has files to compare', () => {
    expect(files.length, 'run `npm run build` first').toBeGreaterThan(0);
    for (const file of files) {
      const extension = file.split('.').pop() ?? '';
      expect(CONTENT_TYPES[extension], `no expected content type for .${extension} (${file})`).toBeDefined();
    }
  });

  for (const file of files) {
    const url = urlFor(file);
    if (!url) continue;

    test(`${url} serves ${file}`, async ({ request }) => {
      const response = await request.get(`${BASE}${url}`, { maxRedirects: 0 });
      expect(response.status()).toBe(200);

      const extension = file.split('.').pop() ?? '';
      const contentType = response.headers()['content-type'] ?? '';
      expect(
        CONTENT_TYPES[extension].some((expected) => contentType.startsWith(expected)),
        `${url} content-type was "${contentType}"`,
      ).toBe(true);

      expect(Buffer.from(await response.body()).equals(readFileSync(join(DIST, file)))).toBe(true);
    });

    if (url !== '/' && url.endsWith('/')) {
      test(`${url.slice(0, -1)} redirects to ${url}`, async ({ request }) => {
        const response = await request.get(`${BASE}${url.slice(0, -1)}`, { maxRedirects: 0 });
        expect([301, 302, 307, 308]).toContain(response.status());
        expect(new URL(response.headers().location ?? '', BASE).pathname).toBe(url);
      });
    }
  }

  test('unknown paths return dist/404.html with a 404 status', async ({ request }) => {
    const response = await request.get(`${BASE}/this-route-should-not-exist/`, { maxRedirects: 0 });
    expect(response.status()).toBe(404);
    expect(Buffer.from(await response.body()).equals(readFileSync(join(DIST, '404.html')))).toBe(true);
  });
});
