// Agent corpus contract (#14): entries come only from checked-in content, carry a stable ID and
// their source file, and the build writes exactly what the extractor produces. Run after a build.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CORPUS_OUTPUT, extractCorpus, isAllowedSource, listCorpusSources } from '../../scripts/corpus/extract.mjs';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
assert.ok(existsSync(distDir), 'dist/ is missing: run `npm run build` first');

const corpus = await extractCorpus({ rootDir, distDir });
const ENTRY_ID = /^(?:(?:project|post)\/[a-z0-9-]+|resume)#[a-z0-9-]+$/;

test('the build wrote the current corpus', () => {
  const file = path.join(rootDir, CORPUS_OUTPUT);
  assert.ok(existsSync(file), `${CORPUS_OUTPUT} is missing: the agent-corpus integration did not run`);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), corpus);
});

test('extraction is deterministic', async () => {
  assert.deepEqual(await extractCorpus({ rootDir, distDir }), corpus);
});

test('entry IDs are unique and well-formed', () => {
  const ids = corpus.entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate entry IDs');
  for (const id of ids) assert.match(id, ENTRY_ID);
  const docIds = corpus.documents.map((doc) => doc.id);
  assert.equal(new Set(docIds).size, docIds.length, 'duplicate document IDs');
});

test('every entry cites an allowed repository file that exists', () => {
  const documents = new Map(corpus.documents.map((doc) => [doc.id, doc]));
  for (const entry of corpus.entries) {
    assert.ok(isAllowedSource(entry.source), `${entry.id}: ${entry.source} is outside the corpus sources`);
    assert.ok(existsSync(path.join(rootDir, entry.source)), `${entry.id}: ${entry.source} does not exist`);
    const doc = documents.get(entry.documentId);
    assert.ok(doc, `${entry.id}: unknown document ${entry.documentId}`);
    assert.equal(entry.source, doc.source);
    assert.ok(entry.id.startsWith(`${doc.id}#`));
    assert.ok(entry.text.trim().length > 0, `${entry.id}: empty text`);
  }
  for (const doc of corpus.documents) {
    for (const source of [doc.source, ...doc.dataSources]) {
      assert.ok(isAllowedSource(source) && existsSync(path.join(rootDir, source)), `${doc.id}: bad source ${source}`);
    }
    assert.deepEqual(doc.entryIds, corpus.entries.filter((e) => e.documentId === doc.id).map((e) => e.id));
  }
});

test('every project, published post and the résumé is in the corpus', async () => {
  const sources = await listCorpusSources(rootDir);
  const included = new Set(corpus.documents.map((doc) => doc.source));
  for (const { source } of sources) {
    if (included.has(source)) continue;
    // Only unpublished drafts may be left out.
    const text = readFileSync(path.join(rootDir, source), 'utf8');
    assert.match(text, /^---[\s\S]*?^draft:\s*true\s*$[\s\S]*?^---/m, `${source} is published but missing from the corpus`);
    assert.ok(corpus.excluded.some((e) => e.source === source));
  }
  assert.ok(included.has('src/pages/resume.astro'));
  assert.ok(corpus.documents.some((doc) => doc.kind === 'project'));
  assert.ok(corpus.documents.some((doc) => doc.kind === 'post'));
});

test('entry links point at built pages and anchors', () => {
  for (const entry of corpus.entries) {
    const [pathname, anchor] = entry.url.split('#');
    const file = path.join(distDir, pathname, 'index.html');
    assert.ok(existsSync(file), `${entry.id}: ${entry.url} was not built`);
    if (anchor) assert.ok(readFileSync(file, 'utf8').includes(`id="${anchor}"`), `${entry.id}: #${anchor} not on the page`);
  }
});

test('page chrome stays out of the corpus', () => {
  const text = corpus.entries.map((entry) => entry.text).join('\n');
  for (const chrome of ['← all work', '← all writing', 'Skip to content', 'Visit project ↗', 'Previous case', 'Next case', 'Case at a glance']) {
    assert.ok(!text.includes(chrome), `corpus contains page chrome: ${chrome}`);
  }
});

test('the case-study facts block repeats the write-up, so it is not a second source for the agent', () => {
  const text = corpus.entries.filter((entry) => entry.kind === 'project').map((entry) => entry.text).join('\n');
  assert.ok(!text.includes('Evidence boundary'), 'a case study\'s facts label reached the corpus');
  assert.ok(!/(^|\n)(Context|Contribution|Result)\n/.test(text), 'a case study\'s facts label reached the corpus');
});
