// Static egress check over the built site: no page, stylesheet or script in dist/ makes the browser
// request a third-party host. Run after `npm run build`. The runtime check is tests/egress.spec.ts.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  SITE_ORIGIN,
  THIRD_PARTY_ALLOWLIST,
  cssUrls,
  htmlRequestUrls,
  isAllowedRequest,
  scriptUrls,
} from '../support/egress.mjs';

const distDir = path.join(process.cwd(), 'dist');

/** @param {string} dir @returns {Promise<string[]>} */
async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out.sort();
}

/** URL of a dist file as served from the site origin. */
const servedUrl = (/** @type {string} */ file) => new URL(path.relative(distDir, file).split(path.sep).join('/'), `${SITE_ORIGIN}/`).href;

/** @param {string} file */
async function requestUrls(file) {
  const content = await readFile(file, 'utf8');
  if (file.endsWith('.html')) return htmlRequestUrls(content);
  if (file.endsWith('.css')) return cssUrls(content).map((url) => ({ url, where: 'stylesheet' }));
  if (/\.m?js$/.test(file)) return scriptUrls(content).map((url) => ({ url, where: 'script' }));
  if (file.endsWith('.webmanifest')) {
    const manifest = JSON.parse(content);
    return [...(manifest.icons ?? []), ...(manifest.screenshots ?? [])].map((/** @type {{ src: string }} */ i) => ({ url: i.src, where: 'manifest' }));
  }
  return [];
}

test('the third-party allowlist starts empty', () => {
  // Turnstile (challenges.cloudflare.com) is the only planned addition, in M4 (#13).
  assert.deepEqual(THIRD_PARTY_ALLOWLIST, []);
});

test('reviewed script references are exact strings, not hosts', () => {
  // A namespace URI or an error-message link is not a request, but nothing else on those hosts is allowed.
  assert.deepEqual(scriptUrls('const ns = "http://www.w3.org/2000/svg"; const e = "https://react.dev/errors/" + code;'), []);
  assert.deepEqual(scriptUrls('fetch("http://www.w3.org/2000/svg/extra"); fetch("https://react.dev/learn")'), [
    'http://www.w3.org/2000/svg/extra',
    'https://react.dev/learn',
  ]);
});

test('the scanner detects third-party requests', () => {
  const html = `<!doctype html><html><head>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
    <style>@import "https://cdn.example.com/a.css"; body { background: url(//cdn.example.com/bg.png) }</style>
    <script>fetch("https://api.example.com/track")</script>
    <script type="application/ld+json">{"url":"https://schema.example.com"}</script>
  </head><body>
    <img srcset="/a.png 1x, https://img.example.com/b.png 2x">
    <a href="https://github.com/">a link is not a request</a>
  </body></html>`;
  const blocked = htmlRequestUrls(html)
    .filter(({ url }) => !isAllowedRequest(url, SITE_ORIGIN))
    .map(({ url }) => new URL(url, SITE_ORIGIN).hostname);
  assert.deepEqual(blocked, [
    'fonts.gstatic.com',
    'fonts.googleapis.com',
    'cdn.example.com',
    'cdn.example.com',
    'api.example.com',
    'img.example.com',
  ]);
});

test('the built site requests nothing from third-party hosts', async () => {
  assert.ok(existsSync(distDir), 'dist/ is missing: run `npm run build` first');
  const files = await listFiles(distDir);
  const violations = [];
  let scanned = 0;
  for (const file of files) {
    const urls = await requestUrls(file);
    if (/\.(html|css|m?js|webmanifest)$/.test(file)) scanned += 1;
    for (const { url, where } of urls) {
      if (!isAllowedRequest(url, servedUrl(file))) violations.push(`${path.relative(distDir, file)}: ${where} ${url}`);
    }
  }
  assert.ok(scanned > 20, `expected to scan the built pages, scanned ${scanned} files`);
  assert.deepEqual(violations, []);
});

test('fonts are served from the site itself', async () => {
  const html = await readFile(path.join(distDir, 'index.html'), 'utf8');
  const fonts = htmlRequestUrls(html).filter(({ url }) => /\.woff2(\?|$)/.test(url));
  assert.ok(fonts.length > 0, 'expected self-hosted @font-face sources on the home page');
  for (const { url } of fonts) {
    const resolved = new URL(url, SITE_ORIGIN);
    assert.equal(resolved.origin, SITE_ORIGIN);
    assert.ok(existsSync(path.join(distDir, resolved.pathname)), `${resolved.pathname} is not in dist/`);
  }
});
