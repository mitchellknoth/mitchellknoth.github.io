// Eval question set contract (#14). Mitch writes and approves the questions; this test checks only
// their shape and that every expected source is a real corpus ID. Run after a build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractCorpus } from '../../scripts/corpus/extract.mjs';

const rootDir = process.cwd();
const set = JSON.parse(readFileSync(path.join(rootDir, 'evals/question-set.json'), 'utf8'));
const corpus = await extractCorpus({ rootDir, distDir: path.join(rootDir, 'dist') });
const corpusIds = new Set([...corpus.documents.map((d) => d.id), ...corpus.entries.map((e) => e.id)]);

const CATEGORIES = ['answerable', 'unanswerable', 'personal-or-social-engineering', 'numeric-trap', 'prompt-injection'];
const REFUSALS = ['not-in-corpus', 'personal', 'social-engineering', 'prompt-injection'];

test('the question set declares exactly the agreed categories', () => {
  assert.equal(set.version, 1);
  assert.deepEqual(Object.keys(set.categories).sort(), [...CATEGORIES].sort());
  for (const [name, category] of Object.entries(set.categories)) {
    assert.ok(category.description, `${name}: missing description`);
    for (const kind of category.allowedExpectations) assert.ok(['sources', 'refusal'].includes(kind), `${name}: ${kind}`);
    for (const refusal of category.allowedRefusals ?? []) assert.ok(REFUSALS.includes(refusal), `${name}: ${refusal}`);
  }
});

test('every question is well-formed and cites real corpus IDs', () => {
  assert.ok(Array.isArray(set.questions));
  const ids = new Set();
  for (const q of set.questions) {
    assert.match(q.id ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `bad question id: ${q.id}`);
    assert.ok(!ids.has(q.id), `duplicate question id: ${q.id}`);
    ids.add(q.id);
    const category = set.categories[q.category];
    assert.ok(category, `${q.id}: unknown category ${q.category}`);
    assert.ok(typeof q.question === 'string' && q.question.trim(), `${q.id}: missing question text`);

    const expected = q.expected ?? {};
    const kinds = ['sources', 'refusal'].filter((kind) => expected[kind] !== undefined);
    assert.equal(kinds.length, 1, `${q.id}: expected needs exactly one of sources or refusal`);
    assert.ok(category.allowedExpectations.includes(kinds[0]), `${q.id}: ${q.category} does not allow ${kinds[0]}`);
    if (expected.sources !== undefined) {
      assert.ok(Array.isArray(expected.sources) && expected.sources.length > 0, `${q.id}: sources must be a non-empty list`);
      for (const id of expected.sources) assert.ok(corpusIds.has(id), `${q.id}: ${id} is not a corpus ID`);
    } else {
      assert.ok(category.allowedRefusals.includes(expected.refusal), `${q.id}: refusal ${expected.refusal} not allowed for ${q.category}`);
    }
  }
});

// The M0 gate reports as TODO until Mitch writes and approves the questions, then becomes a real check.
/** @param {string} name @param {string | false} todo @param {() => void} check */
const gate = (name, todo, check) => (todo ? test(name, { todo }) : test(name, check));

const missing = CATEGORIES.filter((name) => !set.questions.some((q) => q.category === name));
gate('every category has questions', missing.length > 0 && `M0 gate: Mitch writes questions for ${missing.join(', ')}`, () => {
  assert.deepEqual(missing, []);
});

const approved = set.status === 'approved' && Boolean(set.approval.approvedBy && set.approval.approvedOn);
gate('Mitch has approved the question set', !approved && 'M0 gate: set status "approved" with approvedBy and approvedOn', () => {
  assert.ok(approved);
});
