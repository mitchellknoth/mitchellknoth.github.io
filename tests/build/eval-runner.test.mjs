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
import { evalWranglerConfig, readWranglerConfig, requireEvalEnv, serveArgs } from '../../scripts/evals/serve.mjs';

const rootDir = process.cwd();
const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(path.join(rootDir, 'evals/fixtures', name), 'utf8'));
const corpus = fixture('corpus.json');
const questions = fixture('questions.json');
const responses = fixture('responses.json');
const config = JSON.parse(readFileSync(path.join(rootDir, 'evals/config.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

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

test('the runner only targets a local wrangler dev server', () => {
  for (const url of [
    'https://mitchellknoth.com',
    'https://www.mitchellknoth.com/',
    'https://agent.mitchellknoth.com',
    'https://mitchellknoth-com.mitchellknoth.workers.dev',
    'https://3f2a1b9c-mitchellknoth-com.mitchellknoth.workers.dev',
    'http://127.0.0.1.nip.io:8787',
    'http://localhost.evil.example',
    'ftp://127.0.0.1',
  ]) {
    assert.throws(() => assertEvalTarget(url, config), /local|http/i, url);
  }
  assert.deepEqual(assertEvalTarget('http://127.0.0.1:8787', config), { baseUrl: 'http://127.0.0.1:8787', kind: 'local' });
  assert.equal(assertEvalTarget('http://localhost:8787/', config).baseUrl, 'http://localhost:8787');
  assert.equal(assertEvalTarget('http://[::1]:8787', config).kind, 'local');
});

test('the eval server refuses to start without an explicit Cloudflare token and account', () => {
  const ok = { EVAL_MODEL: '@cf/test/model', CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' };
  assert.doesNotThrow(() => requireEvalEnv(ok));
  assert.throws(() => requireEvalEnv({ ...ok, EVAL_MODEL: '' }), /EVAL_MODEL/);
  assert.throws(() => requireEvalEnv({ ...ok, CLOUDFLARE_API_TOKEN: undefined }), /CLOUDFLARE_API_TOKEN/);
  assert.throws(() => requireEvalEnv({ ...ok, CLOUDFLARE_ACCOUNT_ID: ' ' }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.throws(() => requireEvalEnv({}), /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/);
});

test('the eval Wrangler config keeps Durable Objects local, runs only AI remotely, and uses the eval gateway', () => {
  const production = readWranglerConfig(rootDir);
  const configDir = path.join(rootDir, 'generated');
  const evalConfig = evalWranglerConfig(production, { model: '@cf/test/model', configDir, rootDir });

  // Its own Worker name, so the remote proxy's preview upload never uses the production script name.
  assert.equal(evalConfig.name, `${production.name}-evals`);
  assert.equal(path.resolve(configDir, evalConfig.main), path.join(rootDir, production.main));
  assert.equal(path.resolve(configDir, evalConfig.assets.directory), path.resolve(rootDir, production.assets.directory));
  assert.deepEqual(evalConfig.ai, { binding: production.ai.binding, remote: true });
  assert.deepEqual(evalConfig.durable_objects, production.durable_objects);
  assert.deepEqual(evalConfig.migrations, production.migrations);
  assert.equal(evalConfig.vars.AGENT_ENABLED, 'true');
  assert.equal(evalConfig.vars.AI_GATEWAY_ID, config.aiGateway);
  assert.notEqual(evalConfig.vars.AI_GATEWAY_ID, production.vars.AI_GATEWAY_ID, 'never the visitor gateway');
  assert.equal(evalConfig.vars.AGENT_MODEL, '@cf/test/model');
  assert.equal(evalConfig.vars.MAX_PROMPT_CHARS, production.vars.MAX_PROMPT_CHARS);
  assert.equal(evalConfig.$schema, undefined);
  // The production config is not modified.
  assert.equal(readWranglerConfig(rootDir).vars.AGENT_ENABLED, production.vars.AGENT_ENABLED);
});

test('the eval server runs wrangler dev in its default mode, so the AI binding can reach Workers AI', () => {
  const args = serveArgs({ configPath: '/repo/generated/wrangler.evals.json', port: '8787' });
  // --local disables every remote binding, including AI, so the model would never answer.
  assert.ok(!args.includes('--local'));
  assert.ok(!args.includes('--remote'), 'the Worker itself and its Durable Objects stay local');
  assert.equal(args[0], 'dev');
  assert.equal(args[args.indexOf('--config') + 1], '/repo/generated/wrangler.evals.json');
  assert.equal(args[args.indexOf('--ip') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('--port') + 1], '8787');
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

test('a session that cannot open stops the run when the agent is off, and is an error otherwise', async () => {
  const off = /** @type {typeof fetch} */ (async () => Response.json({ state: 'offline' }, { status: 503 }));
  const stoppedRun = await askAll({ baseUrl: BASE, questions, fetch: off, timeoutMs: 1000 });
  assert.equal(stoppedRun.records.length, 1);
  assert.match(stoppedRun.stopped ?? '', /503 offline/);

  const noCookie = /** @type {typeof fetch} */ (async (input) =>
    new URL(String(input)).pathname === '/agent/session' ? Response.json({ state: 'online' }, { status: 201 }) : Response.json({}, { status: 500 }));
  const cookieless = await askAll({ baseUrl: BASE, questions, fetch: noCookie, timeoutMs: 1000 });
  assert.equal(cookieless.stopped, null);
  assert.equal(cookieless.records.length, questions.length);
  assert.match(cookieless.records[0].error ?? '', /no session cookie/);
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
  assert.equal(run.declaredAiGateway, null);
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

test('validateRun reports a malformed scorecard', async () => {
  assert.notDeepEqual(validateRun({ schemaVersion: 2 }), []);
  assert.notDeepEqual(validateRun({ schemaVersion: 1, model: '', date: 'yesterday', results: [], summary: {} }), []);

  const { records } = await askAll({ baseUrl: BASE, questions, fetch: fakeAgent().fetch, timeoutMs: 1000 });
  const good = createRun({ questions, corpus, records, stopped: null, model: '@cf/test/model', target: assertEvalTarget(BASE, config), versions: {}, startedAt: new Date(0), finishedAt: new Date(1) });
  assert.deepEqual(validateRun(good), []);
  const clone = () => JSON.parse(JSON.stringify(good));

  const miscounted = clone();
  miscounted.summary.passed += 1;
  assert.match(validateRun(miscounted).join('\n'), /summary/);

  const badCheck = clone();
  badCheck.results[0].checks.status = { pass: 'yes' };
  assert.match(validateRun(badCheck).join('\n'), /checks/);

  const noCorpus = clone();
  delete noCorpus.corpus;
  assert.match(validateRun(noCorpus).join('\n'), /corpus/);
});

test('scorecards are written per date and model and never overwrite an earlier run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'evals-results-'));
  const run = createRun({ questions, corpus, records: [], stopped: 'test', model: '@cf/meta/llama-4-scout', target: assertEvalTarget(BASE, config), versions: {}, startedAt: new Date('2026-11-05T10:00:00Z'), finishedAt: new Date('2026-11-05T10:00:01Z') });
  const first = await writeRun(run, dir);
  const second = await writeRun(run, dir);
  assert.equal(path.relative(dir, first.json), path.join('2026-11-05', 'cf-meta-llama-4-scout.json'));
  assert.equal(path.relative(dir, first.summary), path.join('2026-11-05', 'cf-meta-llama-4-scout.md'));
  assert.equal(path.relative(dir, second.json), path.join('2026-11-05', 'cf-meta-llama-4-scout--2.json'));
  assert.equal(path.relative(dir, second.summary), path.join('2026-11-05', 'cf-meta-llama-4-scout--2.md'));
  assert.deepEqual(JSON.parse(readFileSync(first.json, 'utf8')), run);
});

test('the CLI requires a model and a local target, then writes a scorecard', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'evals-cli-'));
  const corpusFile = path.join(rootDir, 'evals/fixtures/corpus.json');
  const setFile = path.join(dir, 'set.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(setFile, JSON.stringify({ version: 1, status: 'draft', questions }));
  const quiet = { log: () => {}, error: () => {} };

  await assert.rejects(main(['--base-url', BASE], { fetch: fakeAgent().fetch, console: quiet }), /--model/);
  await assert.rejects(main(['--base-url', 'https://mitchellknoth.com', '--model', '@cf/x/y'], { fetch: fakeAgent().fetch, console: quiet }), /local wrangler dev/);

  const agent = fakeAgent();
  const out = await main(
    ['--base-url', BASE, '--model', '@cf/test/model', '--questions', setFile, '--corpus', corpusFile, '--out', dir],
    { fetch: agent.fetch, console: quiet, now: () => new Date('2026-11-05T12:00:00Z') },
  );
  assert.ok(existsSync(out.json));
  const run = JSON.parse(readFileSync(out.json, 'utf8'));
  assert.deepEqual(validateRun(run), []);
  assert.equal(run.versions.harness, config.harnessVersion);
  assert.equal(run.versions.agents, pkg.dependencies.agents);
  assert.equal(run.declaredAiGateway, config.aiGateway);
  assert.equal(run.summary.total, questions.length);

  // The model can come from EVAL_MODEL, the same variable npm run evals:serve starts the server with.
  const fromEnv = await main(
    ['--base-url', BASE, '--questions', setFile, '--corpus', corpusFile, '--out', dir],
    { fetch: fakeAgent().fetch, console: quiet, env: { EVAL_MODEL: '@cf/env/model' } },
  );
  assert.equal(fromEnv?.run.model, '@cf/env/model');
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

test('the CLI refuses a malformed question set before asking anything', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'evals-bad-'));
  const { writeFileSync } = await import('node:fs');
  const quiet = { log: () => {}, error: () => {} };
  const cases = [
    [[{ id: 'a-1', category: 'answerable', question: 'Q?' }], /expected/],
    [[questions[0], { ...questions[0] }], /duplicate/],
    [[{ ...questions[0], question: 'x'.repeat(5000) }], /too long/],
    [[{ ...questions[0], expected: { sources: ['project/invented'] } }], /not in/],
  ];
  for (const [set, message] of cases) {
    const setFile = path.join(dir, 'set.json');
    writeFileSync(setFile, JSON.stringify({ version: 1, status: 'draft', questions: set }));
    const agent = fakeAgent();
    await assert.rejects(
      main(['--base-url', BASE, '--model', '@cf/x/y', '--questions', setFile, '--corpus', path.join(rootDir, 'evals/fixtures/corpus.json'), '--out', dir], { fetch: agent.fetch, console: quiet }),
      message,
    );
    assert.equal(agent.calls.length, 0, 'nothing is asked');
  }
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
