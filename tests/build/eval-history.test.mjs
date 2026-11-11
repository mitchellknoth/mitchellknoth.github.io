// Benchmark history (Part of #16): compact, hash-chained, append-only records exported from an eval scorecard
// or a Harbor job. Offline: fixtures, temp directories and a throwaway git repo. No model, network or token.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GRADER_VERSION } from '../../scripts/evals/grade.mjs';
import { createRun } from '../../scripts/evals/run.mjs';
import {
  appendRecord,
  canonicalJson,
  compareRecords,
  corpusSha256,
  currentConfig,
  hashRecord,
  questionSetSha256,
  readHarborJob,
  recordFromHarbor,
  recordFromScorecard,
  verifyAppendOnly,
  verifyHistory,
} from '../../scripts/evals/history.mjs';
import { main } from '../../scripts/evals/history-cli.mjs';

const rootDir = process.cwd();
const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(path.join(rootDir, 'evals/fixtures', name), 'utf8'));
const corpus = fixture('corpus.json');
const questions = fixture('questions.json');
const responses = fixture('responses.json');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'eval-history-'));
const COMMIT = 'a'.repeat(40);
const CONFIG = { model: '@cf/test/model', effort: 'low', maxTurns: 6, modelTimeoutMs: 30000, intentMode: 'enforce' };

/** A scorecard graded from the fixture responses, optionally with a per-question latency. */
function scorecard({ latencyMs = 1200, mutate = (/** @type {any[]} */ _records) => {} } = {}) {
  const records = questions.map((/** @type {any} */ q) => {
    const r = responses[q.question];
    return { questionId: q.id, askedAt: '2026-11-11T10:00:00.000Z', latencyMs, httpStatus: r?.status ?? 200, body: r?.body ?? {}, error: null };
  });
  mutate(records);
  return createRun({
    questions, questionSetVersion: 1, corpus, records, stopped: null, model: CONFIG.model,
    target: { baseUrl: 'http://127.0.0.1:8787', kind: 'local' },
    versions: { harness: '1.0.0', grader: GRADER_VERSION, commit: COMMIT },
    startedAt: new Date('2026-11-11T10:00:00Z'), finishedAt: new Date('2026-11-11T10:01:00Z'),
  });
}

const body = () => recordFromScorecard(scorecard(), { config: CONFIG });

test('canonicalJson sorts keys at every depth so a hash does not depend on key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(hashRecord({ a: 1, b: 2 }), hashRecord({ b: 2, a: 1 }));
  assert.match(hashRecord({ a: 1 }), /^[0-9a-f]{64}$/);
  assert.equal(hashRecord({ a: 1, hash: 'ignored' }), hashRecord({ a: 1 }), 'the hash field is not part of what is hashed');
});

test('a record from a scorecard is compact and carries no question or answer text', () => {
  const record = body();
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.source, 'evals-cli');
  assert.equal(record.commit, COMMIT);
  assert.deepEqual(record.config, CONFIG);
  assert.equal(record.graderVersion, GRADER_VERSION);
  assert.equal(record.questionSet.count, questions.length);
  assert.deepEqual(record.coverage, { questions: questions.length, of: questions.length });
  assert.match(record.questionSet.sha256, /^[0-9a-f]{64}$/);
  assert.match(record.corpus.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.summary.trials, questions.length);
  assert.equal(record.questions.length, questions.length);
  for (const q of record.questions) assert.deepEqual(Object.keys(q).sort(), ['category', 'failedChecks', 'id', 'latencyMs', 'outcomes', 'passRate']);

  const text = JSON.stringify(record);
  for (const q of questions) assert.ok(!text.includes(q.question), `question text leaked: ${q.id}`);
  for (const r of Object.values(responses)) assert.ok(!text.includes(/** @type {any} */ (r).body?.text ?? '\u0000'), 'answer text leaked');
  assert.ok(!text.includes('127.0.0.1'), 'the target address is not recorded');
});

test('a failing check is recorded by name, so a regression says what broke', () => {
  const bad = scorecard({
    mutate: (records) => {
      records[1].body = { status: 'answered', text: 'It cut search time by 99%.', sources: [{ id: 'project/sample-tool#results', title: 'x', url: '/work/sample-tool/#results' }] };
    },
  });
  const record = recordFromScorecard(bad, { config: CONFIG });
  const hit = record.questions.find((/** @type {any} */ q) => q.outcomes[0] === 'fail');
  assert.ok(hit, 'one question failed');
  assert.ok(hit.failedChecks.length > 0);
  assert.equal(record.summary.passed, body().summary.passed - 1, 'exactly one more question fails than in the baseline');
});

test('appendRecord chains each record to the previous one and never overwrites', () => {
  const dir = tmp();
  const first = appendRecord(dir, body(), { now: new Date('2026-11-11T12:00:00Z') });
  const second = appendRecord(dir, body(), { now: new Date('2026-11-11T12:05:00Z') });
  assert.equal(first.record.seq, 1);
  assert.equal(first.record.prev, null);
  assert.equal(second.record.seq, 2);
  assert.equal(second.record.prev, first.record.hash);
  assert.equal(second.record.hash, hashRecord(second.record));
  assert.deepEqual(readdirSync(dir).sort(), [`0001-2026-11-11-${COMMIT.slice(0, 7)}.json`, `0002-2026-11-11-${COMMIT.slice(0, 7)}.json`]);
  assert.deepEqual(verifyHistory(dir), []);
});

test('verifyHistory catches an edited record, a deleted record and a broken link', () => {
  const dir = tmp();
  for (let i = 0; i < 3; i += 1) appendRecord(dir, body(), { now: new Date(`2026-11-1${i + 1}T12:00:00Z`) });
  const files = readdirSync(dir).sort();
  const read = (/** @type {string} */ f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));

  const edited = read(files[0]);
  edited.summary.passRate = 1;
  writeFileSync(path.join(dir, files[0]), JSON.stringify(edited));
  assert.match(verifyHistory(dir).join('\n'), /0001.*hash/);

  // Restore it, then "repair" the edit by re-hashing: the next record's `prev` no longer matches.
  edited.hash = hashRecord(edited);
  writeFileSync(path.join(dir, files[0]), JSON.stringify(edited));
  assert.match(verifyHistory(dir).join('\n'), /0002.*prev/);

  const dir2 = tmp();
  for (let i = 0; i < 3; i += 1) appendRecord(dir2, body(), { now: new Date(`2026-11-1${i + 1}T12:00:00Z`) });
  execFileSync('rm', [path.join(dir2, readdirSync(dir2).sort()[1])]);
  assert.match(verifyHistory(dir2).join('\n'), /sequence/);
});

test('appendRecord refuses to extend a history whose chain is broken', () => {
  const dir = tmp();
  const first = appendRecord(dir, body(), { now: new Date('2026-11-11T12:00:00Z') });
  const file = path.join(dir, readdirSync(dir)[0]);
  writeFileSync(file, JSON.stringify({ ...first.record, model: 'tampered' }));
  assert.throws(() => appendRecord(dir, body(), { now: new Date('2026-11-11T13:00:00Z') }), /chain|hash/i);
});

test('verifyAppendOnly allows added files and rejects a modified or deleted history file', () => {
  const repo = tmp();
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const dir = path.join(repo, 'history');
  mkdirSync(dir);
  appendRecord(dir, body(), { now: new Date('2026-11-11T12:00:00Z') });
  git('add', '.');
  git('commit', '-qm', 'one');
  assert.deepEqual(verifyAppendOnly(dir, 'HEAD', { cwd: repo }), []);

  appendRecord(dir, body(), { now: new Date('2026-11-11T13:00:00Z') });
  assert.deepEqual(verifyAppendOnly(dir, 'HEAD', { cwd: repo }), [], 'a new file is an append');

  const first = path.join(dir, readdirSync(dir).sort()[0]);
  writeFileSync(first, `${readFileSync(first, 'utf8')} `);
  assert.match(verifyAppendOnly(dir, 'HEAD', { cwd: repo }).join('\n'), /modified/);

  git('checkout', '--', '.');
  execFileSync('rm', [first]);
  assert.match(verifyAppendOnly(dir, 'HEAD', { cwd: repo }).join('\n'), /deleted/);
});

test('compareRecords lists the questions whose pass rate moved, and what is not comparable', () => {
  const base = body();
  const worse = recordFromScorecard(
    scorecard({
      latencyMs: 2400,
      mutate: (records) => {
        records[1].body = { status: 'answered', text: 'It cut search time by 99%.', sources: [{ id: 'project/sample-tool#results', title: 'x', url: '/work/sample-tool/#results' }] };
      },
    }),
    { config: { ...CONFIG, effort: 'high' } },
  );
  const diff = compareRecords(base, worse);
  assert.equal(diff.regressed.length, 1);
  assert.deepEqual(diff.improved, []);
  assert.ok(diff.passRateDelta < 0);
  assert.deepEqual(diff.configChanges, [{ key: 'effort', from: 'low', to: 'high' }]);
  assert.equal(diff.latency.medianDeltaMs, 1200);
  assert.deepEqual(diff.notComparable, []);

  const subset = { ...base, coverage: { questions: 1, of: 5 }, questions: base.questions.slice(0, 1) };
  assert.deepEqual(compareRecords(base, subset).notComparable, ['coverage'], 'a different set of questions is not like for like');
  assert.equal(compareRecords(base, base).notComparable.length, 0);

  const other = { ...base, questionSet: { ...base.questionSet, sha256: 'b'.repeat(64) }, graderVersion: '9.9.9' };
  assert.deepEqual(compareRecords(base, other).notComparable.sort(), ['graderVersion', 'questionSet']);
});

/** A trimmed Harbor job directory: job result.json plus one trial directory each. */
function harborJob(dir, trials) {
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ id: 'job-1', started_at: '2026-11-11T13:25:36.667391', finished_at: '2026-11-11T13:26:14.509086', n_total_trials: trials.length }));
  trials.forEach((t, i) => {
    const trial = path.join(dir, `${t.task}__x${i}`);
    mkdirSync(path.join(trial, 'verifier'), { recursive: true });
    writeFileSync(path.join(trial, 'result.json'), JSON.stringify({
      task_name: `mitch/${t.task}`, trial_name: `${t.task}__x${i}`,
      verifier_result: t.reward === null ? null : { rewards: { reward: t.reward } },
      exception_info: t.exception ?? null,
      agent_result: { n_input_tokens: 5, n_output_tokens: 50, metadata: { latency_ms: t.latency, http_status: 200, status: 'answered', rounds: 2 } },
    }));
    if (t.grade) writeFileSync(path.join(trial, 'verifier', 'grade.json'), JSON.stringify(t.grade));
  });
}

test('a Harbor job becomes one record with a per-question outcome list per repeat', async () => {
  const dir = tmp();
  const failing = { graderVersion: GRADER_VERSION, outcome: 'fail', checks: { status: { pass: true, detail: 'ok' }, numbers: { pass: false, detail: 'invented 99' } } };
  harborJob(dir, [
    { task: 'answerable-001', reward: 1, latency: 100 },
    { task: 'answerable-001', reward: 1, latency: 300 },
    { task: 'numeric-trap-001', reward: 0, latency: 200, grade: failing },
    { task: 'numeric-trap-001', reward: 1, latency: 400 },
    { task: 'unanswerable-001', reward: null, exception: { exception_type: 'RuntimeError' } },
  ]);
  const job = await readHarborJob(dir);
  assert.equal(job.trials.length, 5);

  const record = recordFromHarbor(job, {
    config: CONFIG, commit: COMMIT, questionSet: { version: 1, count: 38, sha256: 'c'.repeat(64) },
    corpusSha256: 'd'.repeat(64), questions: [
      { id: 'answerable-001', category: 'answerable' }, { id: 'numeric-trap-001', category: 'numeric-trap' }, { id: 'unanswerable-001', category: 'unanswerable' },
      { id: 'prompt-injection-001', category: 'prompt-injection' },
    ],
  });
  assert.deepEqual(record.coverage, { questions: 3, of: 38 }, 'a subset run says so');
  assert.deepEqual(record.questions.map((/** @type {any} */ q) => q.id).sort(), ['answerable-001', 'numeric-trap-001', 'unanswerable-001'], 'questions that were not run are absent, not scored as not_run');
  assert.equal(record.summary.notRun, 0);
  assert.equal(record.source, 'harbor');
  assert.equal(record.graderVersion, GRADER_VERSION);
  assert.equal(record.summary.trials, 5);
  assert.equal(record.summary.passed, 3);
  assert.equal(record.repeats, 2);
  const byId = Object.fromEntries(record.questions.map((/** @type {any} */ q) => [q.id, q]));
  assert.deepEqual(byId['answerable-001'].outcomes, ['pass', 'pass']);
  assert.deepEqual(byId['numeric-trap-001'].outcomes.sort(), ['fail', 'pass']);
  assert.deepEqual(byId['numeric-trap-001'].failedChecks, ['numbers']);
  assert.equal(byId['numeric-trap-001'].passRate, 0.5);
  assert.deepEqual(byId['unanswerable-001'].outcomes, ['error'], 'a trial with no verifier result is an error, not a pass');
  assert.equal(record.latency.medianMs, 250);
  assert.ok(!JSON.stringify(record).includes('latency_ms'));
});

test('currentConfig reads the live agent settings, so a record states what actually ran', () => {
  const config = currentConfig(rootDir, { model: '@cf/test/model' });
  assert.equal(config.model, '@cf/test/model');
  assert.ok(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(config.effort), `effort: ${config.effort}`);
  assert.ok(Number.isInteger(config.maxTurns) && config.maxTurns > 0, 'maxTurns is read from worker/session.ts');
  assert.ok(Number.isInteger(config.modelTimeoutMs) && config.modelTimeoutMs > 0);
  assert.ok(['enforce', 'observe', 'off'].includes(config.intentMode), `intentMode: ${config.intentMode}`);
});

test('the history CLI exports, lists, verifies and compares', async () => {
  const dir = tmp();
  const runs = path.join(tmp(), 'run.json');
  writeFileSync(runs, JSON.stringify(scorecard()));
  const lines = /** @type {string[]} */ ([]);
  const out = { log: (/** @type {string} */ s) => lines.push(s), error: (/** @type {string} */ s) => lines.push(s) };
  const io = { console: out, rootDir, isDirty: () => false, headCommit: () => COMMIT, now: () => new Date('2026-11-11T12:00:00Z') };

  await main(['export', '--scorecard', runs, '--dir', dir], io);
  await main(['export', '--scorecard', runs, '--dir', dir], { ...io, now: () => new Date('2026-11-11T12:30:00Z') });
  assert.equal(readdirSync(dir).length, 2);
  assert.equal(await main(['verify', '--dir', dir], io), 0);
  await main(['compare', '1', '2', '--dir', dir], io);
  assert.match(lines.join('\n'), /Pass rate: .* -> .* \(\+?0 pts\)/);
  await main(['list', '--dir', dir], io);
  assert.match(lines.join('\n'), /0002/);

  writeFileSync(path.join(dir, readdirSync(dir).sort()[0]), '{}');
  assert.equal(await main(['verify', '--dir', dir], io), 1);
  await assert.rejects(() => main(['export', '--dir', dir], io), /--scorecard|--harbor/);
});

// --- Review findings ---------------------------------------------------------------------------------------------

const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const NOW = (/** @type {number} */ n) => new Date(`2026-11-11T12:0${n}:00Z`);

test('appendRecord never replaces an existing file, and a bad commit cannot poison the chain', () => {
  const dir = tmp();
  const first = appendRecord(dir, body(), { now: NOW(0) });
  assert.throws(() => appendRecord(dir, { ...body(), commit: 'HEAD' }, { now: NOW(1) }), /commit/);
  assert.throws(() => appendRecord(dir, { ...body(), commit: '../x' }, { now: NOW(1) }), /commit/);
  assert.deepEqual(verifyHistory(dir), [], 'a refused append leaves the history intact');
  assert.equal(appendRecord(dir, { ...body(), commit: 'ABCDEF1234' }, { now: NOW(2) }).file.endsWith('-abcdef1.json'), true, 'the name part is lower-cased');
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('.')), [], 'no temp files are left behind');
  assert.equal(JSON.parse(readFileSync(first.file, 'utf8')).seq, 1);
});

test('a history that already holds a second writer\'s record for the next sequence is refused, and no file is overwritten', () => {
  const dir = tmp();
  appendRecord(dir, body(), { now: NOW(0) });
  // A second writer already wrote sequence 2 under a different commit name, as a racing process would.
  writeFileSync(path.join(dir, '0002-2026-11-11-bbbbbbb.json'), `${JSON.stringify({ ...JSON.parse(readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8')), seq: 2 })}\n`);
  assert.throws(() => appendRecord(dir, body(), { now: NOW(1) }), /Refusing to append/);
  // And the same-name case, where the record is already there:
  const dir2 = tmp();
  appendRecord(dir2, body(), { now: NOW(0) });
  const clash = path.join(dir2, `0002-2026-11-11-${COMMIT.slice(0, 7)}.json`);
  writeFileSync(clash, 'keep me');
  assert.throws(() => appendRecord(dir2, body(), { now: NOW(1) }));
  assert.equal(readFileSync(clash, 'utf8'), 'keep me', 'an existing file is never overwritten');
});

test('verifyHistory reports a null file, an unreadable file, a reorder and a lying file name instead of throwing', () => {
  const dir = tmp();
  for (let i = 0; i < 3; i += 1) appendRecord(dir, body(), { now: NOW(i) });
  const files = readdirSync(dir).sort();
  const text = files.map((f) => readFileSync(path.join(dir, f), 'utf8'));

  writeFileSync(path.join(dir, files[1]), 'null');
  assert.match(verifyHistory(dir).join('\n'), /0002.*not a record object/);
  writeFileSync(path.join(dir, files[1]), '{ not json');
  assert.match(verifyHistory(dir).join('\n'), /0002.*not valid JSON/);

  writeFileSync(path.join(dir, files[1]), text[2]);
  writeFileSync(path.join(dir, files[2]), text[1]);
  assert.match(verifyHistory(dir).join('\n'), /seq|prev/, 'swapped contents are detected');
  assert.deepEqual(verifyHistory(path.join(dir, 'missing')), [], 'no directory is an empty history');
});

test('hashing agrees with what is written: undefined array items and dates survive the round trip', () => {
  const dir = tmp();
  const { record } = appendRecord(dir, { ...body(), extra: [undefined, 1], when: new Date('2026-01-01T00:00:00Z') }, { now: NOW(0) });
  assert.deepEqual(record.extra, [null, 1]);
  assert.deepEqual(verifyHistory(dir), []);
});

test('verifyAppendOnly rejects a type change and compares against the merge base, not the moved base', () => {
  const repo = tmp();
  const run = (/** @type {string[]} */ ...args) => git(repo, ...args);
  run('init', '-q', '-b', 'main');
  const dir = path.join(repo, 'history');
  mkdirSync(dir);
  appendRecord(dir, body(), { now: NOW(0) });
  run('add', '.');
  run('commit', '-qm', 'one');

  run('switch', '-qc', 'feature');
  appendRecord(dir, body(), { now: NOW(1) });
  run('add', '.');
  run('commit', '-qm', 'feature record');

  run('switch', '-q', 'main');
  appendRecord(dir, body(), { now: NOW(2) });
  run('add', '.');
  run('commit', '-qm', 'main moved ahead');
  run('switch', '-q', 'feature');
  assert.deepEqual(verifyAppendOnly(dir, 'main', { cwd: repo }), [], 'main gaining a record is not a deletion on the branch');

  const first = path.join(dir, readdirSync(dir).sort()[0]);
  execFileSync('rm', [first]);
  execFileSync('ln', ['-s', '/etc/hosts', first]);
  assert.match(verifyAppendOnly(dir, 'main', { cwd: repo }).join('\n'), /changed \(git status T\)/);
});

/** @param {string} dir @param {any[]} trials @param {object} [job] */
const harbor = (dir, trials, job = {}) => {
  harborJob(dir, trials);
  if (Object.keys(job).length) writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ id: 'j', started_at: 'x', finished_at: 'y', n_total_trials: trials.length, ...job }));
};
const harborOptions = {
  config: CONFIG, commit: COMMIT, questionSet: { version: 1, count: 38, sha256: 'c'.repeat(64) }, corpusSha256: 'd'.repeat(64),
  questions: [{ id: 'answerable-001', category: 'answerable' }],
};
const agree = (/** @type {string} */ outcome) => ({ graderVersion: GRADER_VERSION, outcome, checks: {} });

test('a Harbor trial is a pass only when the reward and the grade agree; anything doubtful is an error', async () => {
  const dir = tmp();
  harborJob(dir, [
    { task: 'answerable-001', reward: 1, latency: 1, exception: { exception_type: 'Timeout' } },
    { task: 'answerable-001', reward: 1, latency: 1, grade: agree('fail') },
    { task: 'answerable-001', reward: 0, latency: 1, grade: agree('error') },
    { task: 'answerable-001', reward: 1, latency: 1, grade: agree('pass') },
  ]);
  const record = recordFromHarbor(await readHarborJob(dir), harborOptions);
  assert.deepEqual(record.questions[0].outcomes, ['error', 'error', 'error', 'pass']);
});

test('a crashed trial directory is an error trial, an unfinished job is refused, and a trial count mismatch is refused', async () => {
  const dir = tmp();
  harborJob(dir, [{ task: 'answerable-001', reward: 1, latency: 1, grade: agree('pass') }]);
  mkdirSync(path.join(dir, 'answerable-001__crashed'));
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ id: 'j', started_at: 'x', finished_at: 'y', n_total_trials: 2 }));
  const record = recordFromHarbor(await readHarborJob(dir), harborOptions);
  assert.deepEqual(record.questions[0].outcomes.sort(), ['error', 'pass']);

  const unfinished = tmp();
  harbor(unfinished, [{ task: 'answerable-001', reward: 1, latency: 1 }], { finished_at: null });
  await assert.rejects(() => readHarborJob(unfinished), /not finished/);

  const short = tmp();
  harbor(short, [{ task: 'answerable-001', reward: 1, latency: 1 }], { n_total_trials: 3 });
  await assert.rejects(() => readHarborJob(short), /3 trials but 1/);

  const stranger = tmp();
  harborJob(stranger, [{ task: 'not-in-the-set-001', reward: 1, latency: 1 }]);
  assert.throws(() => recordFromHarbor(/** @type {any} */ (null) ?? { trials: [{ task: 'not-in-the-set-001', reward: 1, grade: null }], startedAt: null, finishedAt: null }, harborOptions), /not in the question set/);
});

test('a record has a fixed set of top-level fields, and free text from a scorecard is reduced to a fixed vocabulary', () => {
  const run = scorecard({
    mutate: (records) => {
      records[1].body = { status: 'answered', text: 'It cut search time by 99%.', sources: [{ id: 'project/sample-tool#results', title: 'x', url: '/work/sample-tool/#results' }] };
    },
  });
  run.stopped = 'HTTP 503 a secret detail the target put in its body';
  run.results[1].checks.surprise = { pass: false, detail: 'secret' };
  const record = recordFromScorecard(run, { config: CONFIG });
  assert.deepEqual(Object.keys(record).sort(), ['commit', 'config', 'corpus', 'coverage', 'finishedAt', 'graderVersion', 'latency', 'questionSet', 'questions', 'repeats', 'schemaVersion', 'source', 'startedAt', 'stopped', 'summary']);
  assert.equal(record.stopped, 'HTTP 503');
  const text = JSON.stringify(record);
  assert.ok(!text.includes('secret'), 'no scorecard free text reaches a record');
  assert.ok(record.questions.flatMap((/** @type {any} */ q) => q.failedChecks).every((/** @type {string} */ n) => ['citations', 'expectedSources', 'injection', 'numbers', 'other', 'refusal', 'status'].includes(n)));
});

test('coverage counts only questions that ran, and compare flags a stopped or partial record', () => {
  const run = scorecard();
  run.results.forEach((/** @type {any} */ r, /** @type {number} */ i) => { if (i > 0) Object.assign(r, { outcome: 'not_run', checks: {}, response: null }); });
  run.stopped = 'HTTP 503 offline';
  const partial = recordFromScorecard(run, { config: CONFIG });
  assert.equal(partial.coverage.questions, 1);
  assert.equal(partial.summary.notRun, questions.length - 1);
  assert.ok(compareRecords(body(), partial).notComparable.includes('completeness'));
  const repeated = { ...body(), repeats: 3 };
  assert.ok(compareRecords(body(), repeated).notComparable.includes('repeats'));
});

test('the exporter hashes the corpus and question set exactly as the eval runner does', () => {
  const run = scorecard();
  assert.equal(corpusSha256(corpus), run.corpus.sha256);
  assert.equal(questionSetSha256(questions), run.questionSet.sha256);
});

test('currentConfig records the effective values the Worker would use', () => {
  const root = tmp();
  mkdirSync(path.join(root, 'worker'));
  writeFileSync(path.join(root, 'worker/session.ts'), 'const x = { maxTurns: 9 };');
  writeFileSync(path.join(root, 'wrangler.jsonc'), '{ "vars": { "AGENT_REASONING": "hgh", "MODEL_TIMEOUT_MS": "-5", "INTENT_MODE": "enforce" } }');
  assert.deepEqual(currentConfig(root, { model: 'm' }), { model: 'm', effort: 'off', maxTurns: 9, modelTimeoutMs: 30000, intentMode: 'enforce' });
});

test('the CLI refuses a scorecard from another commit, a dirty checkout and an invalid scorecard, and gates on --base', async () => {
  const repo = tmp();
  const dir = path.join(repo, 'evals/history');
  const file = path.join(tmp(), 'run.json');
  writeFileSync(file, JSON.stringify(scorecard()));
  const lines = /** @type {string[]} */ ([]);
  const io = { console: { log: (/** @type {string} */ s) => lines.push(s), error: (/** @type {string} */ s) => lines.push(s) }, rootDir, now: () => NOW(0), isDirty: () => false, headCommit: () => COMMIT };

  await assert.rejects(() => main(['export', '--scorecard', file, '--dir', dir], { ...io, headCommit: () => 'b'.repeat(40) }), /wrong code/);
  await assert.rejects(() => main(['export', '--scorecard', file, '--dir', dir], { ...io, isDirty: () => true }), /uncommitted/);
  await main(['export', '--scorecard', file, '--dir', dir, '--allow-dirty'], { ...io, isDirty: () => true });
  assert.equal(JSON.parse(readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8')).dirty, true);
  await assert.rejects(() => main(['export', '--scorecard', file, '--model', 'x', '--dir', dir], io), /--harbor only/);
  const bad = path.join(tmp(), 'bad.json');
  writeFileSync(bad, JSON.stringify({ ...scorecard(), summary: {} }));
  await assert.rejects(() => main(['export', '--scorecard', bad, '--dir', path.join(tmp(), 'h')], io), /not a valid scorecard/);
  await assert.rejects(() => main(['frobnicate'], io), /Unknown command/);
});

test('the CLI exports a Harbor job with the corpus and question set hashed from the checkout', async () => {
  const set = JSON.parse(readFileSync(path.join(rootDir, 'evals/question-set.json'), 'utf8'));
  const first = set.questions[0];
  const jobDir = tmp();
  harborJob(jobDir, [{ task: first.id, reward: 1, latency: 10, grade: agree('pass') }, { task: first.id, reward: 1, latency: 20, grade: agree('pass') }]);
  const dir = tmp();
  const lines = /** @type {string[]} */ ([]);
  await main(['export', '--harbor', jobDir, '--model', 'm/x', '--dir', dir], { console: { log: (/** @type {string} */ s) => lines.push(s), error: () => {} }, rootDir, now: () => NOW(0), isDirty: () => false, headCommit: () => COMMIT });
  const record = JSON.parse(readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.equal(record.questionSet.sha256, questionSetSha256(set.questions));
  assert.equal(record.questionSet.count, set.questions.length);
  assert.deepEqual(record.coverage, { questions: 1, of: set.questions.length });
  assert.equal(record.repeats, 2);
  await assert.rejects(() => main(['export', '--harbor', jobDir, '--dir', dir], { rootDir, isDirty: () => false, headCommit: () => COMMIT }), /--model/);
});
