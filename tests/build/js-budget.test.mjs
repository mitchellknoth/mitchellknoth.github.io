// JavaScript budget. Hydrated shadcn components put React and Base UI on every page (the theme switch is an
// island), so the cost is real and has a ceiling: a page may not ship more than its budget of gzipped JavaScript.
// Counts the scripts an HTML page loads or hydrates, plus every module they statically import. Reads the built
// site, so run `npm run build` first.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const dist = 'dist';
const KB = 1024;

/** gzipped KB a page may ship. Raise a budget only with a reason in the commit; the point is the ceiling. */
const BUDGET_KB = { default: 100, home: 125 };

function htmlPages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '_astro' ? [] : htmlPages(full);
    return entry.name.endsWith('.html') ? [full] : [];
  });
}

const urlsIn = (html) =>
  [
    ...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g),
    ...html.matchAll(/(?:component|renderer|before-hydration)-url="([^"]+)"/g),
    ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
  ].map((m) => m[1].replace(/&amp;/g, '&'));

function closure(entries) {
  const seen = new Set();
  const visit = (url) => {
    const file = path.join(dist, url.split('?')[0].replace(/^\//, ''));
    if (seen.has(file) || !file.endsWith('.js')) return;
    try {
      statSync(file);
    } catch {
      return;
    }
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
      visit('/' + path.posix.join('_astro', m[1]));
    }
  };
  entries.forEach(visit);
  return [...seen];
}

const gzipKb = (files) => files.reduce((sum, f) => sum + gzipSync(readFileSync(f)).length, 0) / KB;

for (const page of htmlPages(dist).sort()) {
  const route = '/' + path.relative(dist, page).replace(/index\.html$/, '').replace(/\.html$/, '');
  const budget = route === '/' ? BUDGET_KB.home : BUDGET_KB.default;
  test(`${route} ships at most ${budget} KB of gzipped JavaScript`, () => {
    const files = closure(urlsIn(readFileSync(page, 'utf8')));
    const size = gzipKb(files);
    assert.ok(size <= budget, `${route} ships ${size.toFixed(1)} KB gzip across ${files.length} files (budget ${budget} KB)`);
  });
}
