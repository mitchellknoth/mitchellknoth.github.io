// Eval runner, scorecard files and CLI (#17). A fake agent stands in for the Worker: it enforces the same
// session contract (Origin check, session cookie) and replays fixture responses. No model or network calls.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { askAll, assertEvalTarget, createRun } from '../../scripts/evals/run.mjs';
import { renderSummary, validateRun, writeRun } from '../../scripts/evals/results.mjs';
import { main } from '../../scripts/evals/cli.mjs';

const rootDir = process.cwd();
const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(path.join(rootDir, 'evals/fixtures', name), 'utf8'));
const corpus = fixture('corpus.json');
const questions = fixture('questions.json');
const responses = fixture('responses.json');
const config = JSON.parse(readFileSync(path.join(rootDir, 'evals/config.json'), 'utf8'));

const BASE = 'http://127.0.0.1:8787';
const COOKIE = '__Host-agent_session';

/**
 * A fake Worker with the M2/M3 contract. `override(question, n)` may return a Response (or throw) to
 * simulate failures for the n-th ask.
 * @param {{ override?: (question: string, n: number) => Response | undefined }} [options]
 */
function fakeAgent({ override } = {}) {
  /** @type {Array<{ path: string, origin: string | null, cookie: string | null, body: any }>} */
  const calls = [];
  const issued = new Set();
  let asks = 0;
  /** @type {typeof fetch} */
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: url.pathname, origin: headers.get('origin'), cookie: headers.get('cookie'), body });
    if (init.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    if (headers.get('origin') !== url.origin) return Response.json({ error: 'cross_origin' }, { status: 403 });
    if (url.pathname === '/agent/session') {
      const name = crypto.randomUUID();
      issued.add(name);
      return Response.json({ state: 'online' }, {
        status: 201,
        headers: { 'set-cookie': `${COOKIE}=${name}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400` },
      });
    }
    if (url.pathname === '/agent/ask') {
      const name = /__Host-agent_session=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1];
      if (!name || !issued.has(name)) return Response.json({ error: 'no_session' }, { status: 401 });
      asks += 1;
      const custom = override?.(body.question, asks);
      if (custom) return custom;
      const reply = responses[body.question];
      return Response.json(reply.body, { status: reply.status });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  return { fetch: fakeFetch, calls };
}

test('the runner refuses production targets and accepts local and preview ones', () => {
  for (const url of [
    'https://mitchellknoth.com',
    'https://www.mitchellknoth.com/',
    'https://mitchellknoth-com.mitchellknoth.workers.dev',
    'https://MITCHELLKNOTH.COM./',
    'ftp://127.0.0.1',
  ]) {
    assert.throws(() => assertEvalTarget(url, config), /production|http/i, url);
  }
  assert.equal(assertEvalTarget('http://127.0.0.1:8787', config).kind, 'local');
  assert.equal(assertEvalTarget('http://localhost:8787/', config).kind, 'local');
  assert.equal(assertEvalTarget('https://3f2a1b9c-mitchellknoth-com.mitchellknoth.workers.dev', config).kind, 'preview');
});

test('each question gets its own session, opened with the site Origin and asked with its cookie', async () => {
  const agent = fakeAgent();
  const { records, stopped } = await askAll({ baseUrl: BASE, questions, fetch: agent.fetch, timeoutMs: 1000 });
  assert.equal(stopped, null);
  assert.equal(records.length, questions.length);

  const sessions = agent.calls.filter((c) => c.path === '/agent/session');
  const asks = agent.calls.filter((c) => c.path === '/agent/ask');
  assert.equal(sessions.length, questions.length);
  assert.equal(asks.length, questions.length);
  for (const call of agent.calls) assert.equal(call.origin, BASE);
  const cookies = asks.map((c) => c.cookie);
  assert.ok(cookies.every((c) => c?.startsWith(`${COOKIE}=`)));
  assert.equal(new Set(cookies).size, questions.length, 'no two questions share a session');
  assert.deepEqual(asks.map((c) => c.body), questions.map((q) => ({ question: q.question })));

  for (const [i, record] of records.entries()) {
    assert.equal(record.questionId, questions[i].id);
    assert.equal(record.httpStatus, 200);
    assert.deepEqual(record.body, responses[questions[i].question].body);
    assert.equal(typeof record.latencyMs, 'number');
  }
});

test('a paused or blocked agent stops the run; the rest are marked not run', async () => {
  const agent = fakeAgent({
    override: (_q, n) => (n === 2 ? Response.json({ state: 'paused', until: '2026-11-06T00:00:00.000Z' }, { status: 503 }) : undefined),
  });
  const { records, stopped } = await askAll({ baseUrl: BASE, questions, fetch: agent.fetch, timeoutMs: 1000 });
  assert.match(stopped ?? '', /503 paused/);
  assert.equal(records.length, 2);
  assert.equal(records[1].httpStatus, 503);

  const run = createRun({ questions, corpus, records, stopped, model: '@cf/test/model', target: assertEvalTarget(BASE, config), versions: {}, startedAt: new Date(0), finishedAt: new Date(1000) });
  assert.deepEqual(run.results.map((r) => r.outcome), ['pass', 'error', 'not_run', 'not_run', 'not_run']);
  assert.equal(run.summary.notRun, 3);
});

test('transport failures, timeouts and non-JSON bodies are recorded as errors without stopping the run', async () => {
  const agent = fakeAgent({
    override: (_q, n) => {
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
      return undefined;
    },
  });
  const { records, stopped } = await askAll({ baseUrl: BASE, questions, fetch: agent.fetch, timeoutMs: 1000 });
  assert.equal(stopped, null);
  assert.equal(records.length, questions.length);
  assert.equal(records[0].httpStatus, null);
  assert.match(records[0].error ?? '', /fetch failed/);
  assert.deepEqual(records[1].body, { raw: '<html>Bad gateway</html>' });

  // A server that never answers. The pending timer stands in for the open socket that keeps a real fetch alive.
  const slow = { fetch: /** @type {typeof fetch} */ ((_url, init) => new Promise((_resolve, reject) => {
    const hang = setTimeout(() => {}, 10_000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(hang);
      reject(init.signal?.reason);
    });
  })) };
  const timed = await askAll({ baseUrl: BASE, questions: questions.slice(0, 1), fetch: slow.fetch, timeoutMs: 20 });
  assert.match(timed.records[0].error ?? '', /timeout|abort/i);
});

test('a run records the model, versions, raw responses, grades and a summary in a stable shape', async () => {
  const agent = fakeAgent();
  const { records, stopped } = await askAll({ baseUrl: BASE, questions, fetch: agent.fetch, timeoutMs: 1000 });
  const run = createRun({
    questions,
    questionSetVersion: 1,
    corpus,
    records,
    stopped,
    model: '@cf/test/model',
    target: assertEvalTarget(BASE, config),
    versions: { harness: '1.0.0', grader: '1.0.0', agents: '0.33.0' },
    startedAt: new Date('2026-11-05T10:00:00Z'),
    finishedAt: new Date('2026-11-05T10:01:00Z'),
  });
  assert.equal(run.schemaVersion, 1);
  assert.equal(run.model, '@cf/test/model');
  assert.equal(run.date, '2026-11-05');
  assert.deepEqual(run.target, { baseUrl: BASE, kind: 'local' });
  assert.deepEqual(run.versions, { harness: '1.0.0', grader: '1.0.0', agents: '0.33.0' });
  assert.match(run.corpus.sha256, /^[0-9a-f]{64}$/);
  assert.equal(run.results.length, questions.length);
  assert.equal(run.results[0].response.body.status, 'answered');
  assert.equal(run.results[0].question, questions[0].question);
  assert.deepEqual(run.results.map((r) => r.outcome), ['pass', 'pass', 'pass', 'fail', 'pass']);
  assert.equal(run.summary.passed, 4);
  assert.equal(run.summary.passRate, 0.8);
  assert.deepEqual(validateRun(run), []);

  const md = renderSummary(run);
  assert.match(md, /@cf\/test\/model/);
  assert.match(md, /4 of 5 passed \(80%\)/);
  assert.match(md, /personal-001/);
});

test('validateRun reports a malformed scorecard', () => {
  assert.notDeepEqual(validateRun({ schemaVersion: 2 }), []);
  assert.notDeepEqual(validateRun({ schemaVersion: 1, model: '', date: 'yesterday', results: [], summary: {} }), []);
});

test('scorecards are written per date and model and never overwrite an earlier run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'evals-results-'));
  const run = createRun({ questions, corpus, records: [], stopped: 'test', model: '@cf/meta/llama-4-scout', target: assertEvalTarget(BASE, config), versions: {}, startedAt: new Date('2026-11-05T10:00:00Z'), finishedAt: new Date('2026-11-05T10:00:01Z') });
  const first = await writeRun(run, dir);
  const second = await writeRun(run, dir);
  assert.equal(path.relative(dir, first.json), path.join('2026-11-05', 'cf-meta-llama-4-scout.json'));
  assert.equal(path.relative(dir, first.summary), path.join('2026-11-05', 'cf-meta-llama-4-scout.md'));
  assert.equal(path.relative(dir, second.json), path.join('2026-11-05', 'cf-meta-llama-4-scout-2.json'));
  assert.deepEqual(JSON.parse(readFileSync(first.json, 'utf8')), run);
});

test('the CLI requires a model and a non-production target, then writes a scorecard', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'evals-cli-'));
  const corpusFile = path.join(rootDir, 'evals/fixtures/corpus.json');
  const setFile = path.join(dir, 'set.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(setFile, JSON.stringify({ version: 1, status: 'draft', questions }));
  const quiet = { log: () => {}, error: () => {} };

  await assert.rejects(main(['--base-url', BASE], { fetch: fakeAgent().fetch, console: quiet }), /--model/);
  await assert.rejects(main(['--base-url', 'https://mitchellknoth.com', '--model', '@cf/x/y'], { fetch: fakeAgent().fetch, console: quiet }), /production/);

  const agent = fakeAgent();
  const out = await main(
    ['--base-url', BASE, '--model', '@cf/test/model', '--questions', setFile, '--corpus', corpusFile, '--out', dir],
    { fetch: agent.fetch, console: quiet, now: () => new Date('2026-11-05T12:00:00Z') },
  );
  assert.ok(existsSync(out.json));
  const run = JSON.parse(readFileSync(out.json, 'utf8'));
  assert.deepEqual(validateRun(run), []);
  assert.equal(run.versions.harness, config.harnessVersion);
  assert.equal(run.versions.agents, '0.33.0');
  assert.equal(run.aiGateway, config.aiGateway);
  assert.equal(run.summary.total, questions.length);
});

test('the CLI refuses to run an empty question set', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'evals-empty-'));
  const setFile = path.join(dir, 'set.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(setFile, JSON.stringify({ version: 1, status: 'draft', questions: [] }));
  await assert.rejects(
    main(['--base-url', BASE, '--model', '@cf/x/y', '--questions', setFile, '--corpus', path.join(rootDir, 'evals/fixtures/corpus.json'), '--out', dir], { fetch: fakeAgent().fetch, console: { log: () => {}, error: () => {} } }),
    /no questions/i,
  );
});

test('every committed scorecard under evals/results is valid', () => {
  const resultsDir = path.join(rootDir, 'evals/results');
  const files = existsSync(resultsDir)
    ? readdirSync(resultsDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json'))
    : [];
  for (const file of files) {
    const run = JSON.parse(readFileSync(path.join(resultsDir, file), 'utf8'));
    assert.deepEqual(validateRun(run), [], file);
    assert.equal(path.dirname(file), run.date, `${file} must sit in its run date's folder`);
  }
});
