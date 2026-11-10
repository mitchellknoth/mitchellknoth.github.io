import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

// Workers static assets answer a path containing `@` with a 307 to its percent-encoded form (found when the
// island's stylesheet became `index@_@astro.<hash>.css`), so every emitted file name stays URL-safe.
// astro.config.mjs sets the asset name pattern; this guards the rest of dist/ (entry and chunk names too).
const distDir = path.resolve('dist');

/** @param {string} dir @returns {Promise<string[]>} */
async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)])));
  return nested.flat();
}

test('no emitted file name needs percent-encoding', async () => {
  assert.ok(existsSync(distDir), 'dist/ is missing: run `npm run build` first');
  const unsafe = (await listFiles(distDir))
    .map((file) => path.relative(distDir, file).split(path.sep).join('/'))
    .filter((relative) => /[^A-Za-z0-9._~\/-]/.test(relative));
  assert.deepEqual(unsafe, []);
});
