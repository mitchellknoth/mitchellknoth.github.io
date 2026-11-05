// Eval question set contract (#14). Mitch writes and approves the questions; this test checks only
// their shape and that every expected source is a real corpus ID. Run after a build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractCorpus } from '../../scripts/corpus/extract.mjs';
import { REFUSALS, maxPromptChars, validateQuestions } from '../../scripts/evals/questions.mjs';

const rootDir = process.cwd();
const set = JSON.parse(readFileSync(path.join(rootDir, 'evals/question-set.json'), 'utf8'));
const corpus = await extractCorpus({ rootDir, distDir: path.join(rootDir, 'dist') });
const corpusIds = new Set([...corpus.documents.map((d) => d.id), ...corpus.entries.map((e) => e.id)]);

const CATEGORIES = ['answerable', 'unanswerable', 'personal-or-social-engineering', 'numeric-trap', 'prompt-injection'];

test('the question set declares exactly the agreed categories', () => {
  assert.equal(set.version, 1);
  assert.deepEqual(Object.keys(set.categories).sort(), [...CATEGORIES].sort());
  for (const [name, category] of Object.entries(set.categories)) {
    assert.ok(category.description, `${name}: missing description`);
    for (const kind of category.allowedExpectations) assert.ok(['sources', 'refusal'].includes(kind), `${name}: ${kind}`);
    for (const refusal of category.allowedRefusals ?? []) assert.ok(REFUSALS.includes(refusal), `${name}: ${refusal}`);
  }
});

test('every question is well-formed, fits the agent prompt limit and cites real corpus IDs', () => {
  assert.deepEqual(validateQuestions(set, { corpusIds, maxChars: maxPromptChars(rootDir) }), []);
});

test('the question validator catches each malformed question', () => {
  const good = { id: 'answerable-001', category: 'answerable', question: 'Q?', expected: { sources: [[...corpusIds][0]] } };
  const cases = [
    [{ ...good, id: 'Bad ID' }, /bad question id/],
    [{ ...good, category: 'gossip' }, /unknown category/],
    [{ ...good, question: ' ' }, /missing question text/],
    [{ ...good, question: 'x'.repeat(2000) }, /too long/],
    [{ ...good, expected: {} }, /exactly one/],
    [{ ...good, expected: { sources: ['a'], refusal: 'personal' } }, /exactly one/],
    [{ ...good, expected: { refusal: 'personal' } }, /does not allow refusal/],
    [{ ...good, expected: { sources: [] } }, /non-empty list/],
    [{ ...good, expected: { sources: ['project/invented'] } }, /not in the corpus/],
    [{ ...good, category: 'unanswerable', expected: { refusal: 'personal' } }, /not allowed/],
    [{ ...good, forbidden: ['X'] }, /only to prompt-injection/],
    [{ ...good, category: 'prompt-injection', forbidden: [''] }, /non-empty strings/],
  ];
  for (const [question, message] of cases) {
    assert.match(validateQuestions({ ...set, questions: [question] }, { corpusIds, maxChars: 1000 }).join('\n'), message, JSON.stringify(question));
  }
  assert.match(validateQuestions({ ...set, questions: [good, good] }, { corpusIds }).join('\n'), /duplicate/);
  assert.deepEqual(validateQuestions({ ...set, questions: [good] }, { corpusIds, maxChars: 1000 }), []);
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
