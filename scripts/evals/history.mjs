// Benchmark history (Part of #16). A record is a compact summary of one eval run: what ran (commit, model,
// effort, maxTurns, question set, corpus, grader), how each question did over its repeats, and how long answers
// took. Records are hash-chained: each stores the hash of the one before it, so editing, deleting or reordering an
// earlier record is detectable. A record holds no question text, answer text, IP, session name or target address,
// and every free-text field of a scorecard is reduced to a fixed vocabulary before it is stored.
//
// Records come from the existing scorecard (`npm run evals`) or from a Harbor job directory
// (experiments/harbor); the record format does not depend on either runner.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

export const RECORD_SCHEMA_VERSION = 1;
const FILE_PATTERN = /^(\d{4,})-\d{4}-\d{2}-\d{2}-[0-9a-z]+\.json$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{7,40}|unknown)$/;
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_MODEL_TIMEOUT_MS = 30_000;
/** The checks scripts/evals/grade.mjs can report. Anything else in a scorecard or grade file is stored as `other`. */
const KNOWN_CHECKS = ['citations', 'expectedSources', 'injection', 'numbers', 'refusal', 'status'];

/**
 * JSON with object keys sorted at every depth, so a hash never depends on key order. It agrees with a JSON
 * round trip: `undefined` in an array is `null`, and `toJSON` (a Date) is honoured.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  const plain = value && typeof value === 'object' && typeof (/** @type {any} */ (value)).toJSON === 'function' ? /** @type {any} */ (value).toJSON() : value;
  if (Array.isArray(plain)) return `[${plain.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (plain && typeof plain === 'object') {
    const entries = Object.entries(plain).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(plain) ?? 'null';
}

/** The record's hash: sha256 of its canonical JSON without the `hash` field itself. @param {Record<string, any>} record */
export function hashRecord(record) {
  const { hash: _ignored, ...rest } = record;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/** @param {unknown} value */
const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** The same hash scripts/evals/run.mjs records for the question set. @param {unknown[]} questions */
export const questionSetSha256 = (questions) => sha256(questions);

/** The same hash scripts/evals/run.mjs records for the corpus. @param {{ documents: unknown, entries: unknown }} corpus */
export const corpusSha256 = (corpus) => sha256({ documents: corpus.documents, entries: corpus.entries });

/** @param {number[]} values @param {number} q @returns {number | null} */
function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo));
}

const round4 = (/** @type {number} */ n) => Math.round(n * 10000) / 10000;

/** Failed check names, limited to the grader's own vocabulary. @param {Record<string, any> | undefined} checks */
const failedCheckNames = (checks) => [...new Set(Object.entries(checks ?? {}).filter(([, c]) => !c?.pass).map(([name]) => (KNOWN_CHECKS.includes(name) ? name : 'other')))].sort();

/**
 * Shared shape: collapses per-trial rows into per-question rows plus a summary and a latency summary.
 * @param {Array<{ id: string, category: string, outcome: 'pass' | 'fail' | 'error' | 'not_run', failedChecks: string[], latencyMs: number | null }>} trials
 * @param {Array<{ id: string, category: string }>} questions every question to report, in order
 */
function summarize(trials, questions) {
  const byId = new Map(questions.map((q) => [q.id, { id: q.id, category: q.category, outcomes: /** @type {string[]} */ ([]), failed: new Set(), latencies: /** @type {number[]} */ ([]) }]));
  for (const t of trials) {
    const row = byId.get(t.id) ?? byId.set(t.id, { id: t.id, category: t.category, outcomes: [], failed: new Set(), latencies: [] }).get(t.id);
    row?.outcomes.push(t.outcome);
    for (const name of t.failedChecks) row?.failed.add(name);
    if (typeof t.latencyMs === 'number') row?.latencies.push(t.latencyMs);
  }
  const rows = [...byId.values()].map((row) => {
    const outcomes = row.outcomes.length ? row.outcomes : ['not_run'];
    return {
      category: row.category,
      failedChecks: [...row.failed].sort(),
      id: row.id,
      latencyMs: row.latencies,
      outcomes,
      passRate: round4(outcomes.filter((o) => o === 'pass').length / outcomes.length),
    };
  });
  const all = rows.flatMap((r) => r.outcomes);
  const count = (/** @type {string} */ o) => all.filter((x) => x === o).length;
  /** @type {Record<string, { trials: number, passed: number }>} */
  const byCategory = {};
  for (const r of rows) {
    const c = (byCategory[r.category] ??= { trials: 0, passed: 0 });
    c.trials += r.outcomes.length;
    c.passed += r.outcomes.filter((o) => o === 'pass').length;
  }
  const latencies = rows.flatMap((r) => r.latencyMs);
  return {
    repeats: Math.max(1, ...rows.map((r) => r.outcomes.length)),
    summary: {
      byCategory,
      errors: count('error'),
      failed: count('fail'),
      notRun: count('not_run'),
      passRate: all.length ? round4(count('pass') / all.length) : 0,
      passed: count('pass'),
      questions: rows.length,
      trials: all.length,
    },
    latency: { medianMs: quantile(latencies, 0.5), p90Ms: quantile(latencies, 0.9) },
    questions: rows,
  };
}

/**
 * A record body (no seq, prev or hash yet) from a scorecard written by `npm run evals`. A scorecard counts every
 * question in the set, so a stopped run shows its unrun questions as `not_run`; `coverage` counts only the
 * questions that actually ran.
 * @param {any} run a scorecard (evals/results/*.json)
 * @param {{ config: Config, commit?: string, dirty?: boolean }} options
 */
export function recordFromScorecard(run, { config, commit, dirty }) {
  const trials = run.results.map((/** @type {any} */ r) => ({
    id: r.questionId,
    category: r.category,
    outcome: r.outcome,
    failedChecks: failedCheckNames(r.checks),
    latencyMs: typeof r.response?.latencyMs === 'number' ? r.response.latencyMs : null,
  }));
  // `stopped` is built from the target's response body; keep only its HTTP status.
  const stoppedStatus = typeof run.stopped === 'string' ? /^HTTP (\d{3})/.exec(run.stopped)?.[1] : null;
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    source: 'evals-cli',
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    commit: commit ?? run.versions?.commit ?? 'unknown',
    ...(dirty ? { dirty: true } : {}),
    config,
    graderVersion: run.versions?.grader ?? 'unknown',
    questionSet: { version: run.questionSet.version ?? null, count: run.questionSet.count, sha256: run.questionSet.sha256 },
    corpus: { sha256: run.corpus.sha256 },
    stopped: run.stopped == null ? null : stoppedStatus ? `HTTP ${stoppedStatus}` : 'stopped',
    coverage: { questions: run.results.filter((/** @type {any} */ r) => r.outcome !== 'not_run').length, of: run.questionSet.count },
    ...summarize(trials, run.results.map((/** @type {any} */ r) => ({ id: r.questionId, category: r.category }))),
  };
}

/** @typedef {{ model: string, effort: string, maxTurns: number | null, modelTimeoutMs: number, intentMode: string | null }} Config */

/**
 * The agent settings that decide how it behaves, read from the checkout (not from the caller's memory), so a
 * record says what the code under test was configured to do. Values are the effective ones, as the Worker reads
 * them (an unknown effort is `off`; a bad timeout is the default). Only the model comes from outside: the agent's
 * API does not report it.
 * @param {string} rootDir
 * @param {{ model: string }} options
 * @returns {Config}
 */
export function currentConfig(rootDir, { model }) {
  const errors = /** @type {import('jsonc-parser').ParseError[]} */ ([]);
  const wrangler = parseJsonc(readFileSync(path.join(rootDir, 'wrangler.jsonc'), 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('wrangler.jsonc does not parse');
  const vars = wrangler.vars ?? {};
  const session = readFileSync(path.join(rootDir, 'worker/session.ts'), 'utf8');
  const turns = /\bmaxTurns:\s*(\d+)/.exec(session);
  const timeout = Number.parseInt(vars.MODEL_TIMEOUT_MS ?? '', 10);
  return {
    model,
    effort: REASONING_LEVELS.includes(vars.AGENT_REASONING) ? vars.AGENT_REASONING : 'off',
    maxTurns: turns ? Number(turns[1]) : null,
    modelTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_MODEL_TIMEOUT_MS,
    intentMode: vars.INTENT_MODE ?? null,
  };
}

/** @param {string} file */
async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reads a Harbor job directory: the per-trial result, the verifier's grade (when it wrote one) and what the
 * adapter put in `metadata`. Refuses a job that has not finished or whose trial directories do not match its
 * trial count, since the record would then understate the denominator. A trial directory with no readable
 * result (a crashed trial) is read as an error trial, never skipped.
 * @param {string} jobDir
 */
export async function readHarborJob(jobDir) {
  const job = JSON.parse(await readFile(path.join(jobDir, 'result.json'), 'utf8'));
  if (!job.finished_at) throw new Error(`${jobDir} has no finished_at: the Harbor job has not finished, so it cannot be recorded.`);
  const trials = [];
  for (const entry of (await readdir(jobDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !entry.name.includes('__')) continue;
    const result = await readJsonOrNull(path.join(jobDir, entry.name, 'result.json'));
    const grade = await readJsonOrNull(path.join(jobDir, entry.name, 'verifier', 'grade.json'));
    const reward = result?.verifier_result?.rewards?.reward;
    trials.push({
      task: String(result?.task_name ?? entry.name.split('__')[0]).split('/').pop() ?? entry.name,
      reward: typeof reward === 'number' ? reward : null,
      crashed: result === null,
      exception: result?.exception_info ? String(result.exception_info.exception_type ?? 'exception') : null,
      grade,
      startedAt: result?.started_at ?? null,
      finishedAt: result?.finished_at ?? null,
      latencyMs: result?.agent_result?.metadata?.latency_ms ?? null,
    });
  }
  if (Number.isInteger(job.n_total_trials) && job.n_total_trials !== trials.length) {
    throw new Error(`${jobDir}: the job reports ${job.n_total_trials} trials but ${trials.length} trial directories were found.`);
  }
  return { id: job.id, startedAt: job.started_at ?? null, finishedAt: job.finished_at ?? null, trials };
}

/**
 * A record body from a Harbor job. Harbor knows neither the commit nor the config, so the caller supplies them.
 * A trial is a pass only when the verifier's reward is 1 and, if it wrote a grade, the grade agrees. No reward,
 * an exception, a crashed trial or a reward/grade disagreement is an `error`, never a pass.
 * @param {Awaited<ReturnType<typeof readHarborJob>>} job
 * @param {{ config: Config, commit: string, dirty?: boolean, questionSet: { version: number | null, count: number, sha256: string }, corpusSha256: string, questions: Array<{ id: string, category: string }> }} options
 */
export function recordFromHarbor(job, { config, commit, dirty, questionSet, corpusSha256: corpusHash, questions }) {
  const category = new Map(questions.map((q) => [q.id, q.category]));
  const unknown = [...new Set(job.trials.map((t) => t.task).filter((id) => !category.has(id)))];
  if (unknown.length) throw new Error(`The job ran tasks that are not in the question set: ${unknown.join(', ')}.`);
  const trials = job.trials.map((t) => {
    const graded = t.grade?.outcome;
    /** @type {'pass' | 'fail' | 'error'} */
    let outcome;
    if (t.crashed || t.exception || t.reward === null || graded === 'error') outcome = 'error';
    else if (t.reward >= 1) outcome = graded === undefined || graded === 'pass' ? 'pass' : 'error';
    else outcome = graded === undefined || graded === 'fail' ? 'fail' : 'error';
    return { id: t.task, category: /** @type {string} */ (category.get(t.task)), outcome, failedChecks: failedCheckNames(t.grade?.checks), latencyMs: typeof t.latencyMs === 'number' ? t.latencyMs : null };
  });
  const ran = new Set(trials.map((t) => t.id));
  const graderVersion = job.trials.map((t) => t.grade?.graderVersion).find((v) => typeof v === 'string') ?? 'unknown';
  const stamps = (/** @type {'startedAt' | 'finishedAt'} */ key) => job.trials.map((t) => t[key]).filter(Boolean).sort();
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    source: 'harbor',
    startedAt: stamps('startedAt')[0] ?? job.startedAt,
    finishedAt: stamps('finishedAt').at(-1) ?? job.finishedAt,
    commit,
    ...(dirty ? { dirty: true } : {}),
    config,
    graderVersion,
    questionSet,
    corpus: { sha256: corpusHash },
    stopped: null,
    // A Harbor job may run a subset of the set. Questions it did not run are absent (not scored as not_run), and
    // the coverage says how much of the set this record speaks for.
    coverage: { questions: ran.size, of: questionSet.count },
    ...summarize(trials, questions.filter((q) => ran.has(q.id))),
  };
}

/** @param {string} dir @returns {string[]} sorted record file names */
export function recordFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}

/** @param {string} dir @param {string} file */
const readRecord = (dir, file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));

/** Every record in order, without checking the chain. @param {string} dir */
export const readHistory = (dir) => recordFiles(dir).map((f) => readRecord(dir, f));

/**
 * Lists what is wrong with a history directory: a record that does not match its hash, a `prev` that does not
 * point at the record before it, a gap or duplicate in the sequence, an unreadable file, or a file name that
 * does not match its record. Deleting the newest record leaves a valid chain; `verifyAppendOnly` catches that.
 * @param {string} dir
 * @returns {string[]}
 */
export function verifyHistory(dir) {
  const problems = [];
  let prev = null;
  let expected = 1;
  for (const file of recordFiles(dir)) {
    const match = FILE_PATTERN.exec(file);
    let record;
    try {
      record = readRecord(dir, file);
    } catch {
      problems.push(`${file}: not valid JSON`);
      expected += 1;
      continue;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      problems.push(`${file}: not a record object`);
      expected += 1;
      continue;
    }
    const seq = match ? Number(match[1]) : NaN;
    if (!match) problems.push(`${file}: file name is not NNNN-YYYY-MM-DD-<commit>.json`);
    if (seq !== expected) problems.push(`${file}: sequence jumps (expected ${String(expected).padStart(4, '0')})`);
    if (record.seq !== seq) problems.push(`${file}: record seq ${record.seq} does not match its file name`);
    if (record.hash !== hashRecord(record)) problems.push(`${file}: hash does not match the record's contents`);
    if ((record.prev ?? null) !== prev) problems.push(`${file}: prev does not match the previous record's hash`);
    prev = record.hash ?? null;
    expected = (Number.isFinite(seq) ? seq : expected) + 1;
  }
  return problems;
}

/**
 * Writes the next record. It refuses to extend a history that already fails verification, refuses a commit that
 * is not a hex prefix (the name is part of the chain's checks, so a bad one would end the history), and takes the
 * file with a hard link (which fails if the name exists) after a temporary file is fully written, so a crash
 * never leaves a half-written record. If the new record leaves the chain broken (a racing writer took the same
 * sequence number), it removes its own file again.
 * @param {string} dir
 * @param {Record<string, any>} body a record without seq, prev or hash
 * @param {{ now?: Date }} [options]
 */
export function appendRecord(dir, body, { now = new Date() } = {}) {
  const commit = String(body.commit ?? '').toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`commit must be a hex commit id (7 to 40 characters) or "unknown", not "${body.commit}".`);
  mkdirSync(dir, { recursive: true });
  const problems = verifyHistory(dir);
  if (problems.length) throw new Error(`Refusing to append: the history chain is broken.\n- ${problems.join('\n- ')}`);
  const files = recordFiles(dir);
  const last = files.length ? readRecord(dir, files.at(-1) ?? '') : null;
  const seq = (last?.seq ?? 0) + 1;
  const prefix = `${String(seq).padStart(4, '0')}-`;

  // Round-trip through JSON so the hash is of exactly what is written and read back.
  const record = JSON.parse(JSON.stringify({ ...body, commit, seq, prev: last?.hash ?? null, recordedAt: now.toISOString() }));
  record.hash = hashRecord(record);
  const file = path.join(dir, `${prefix}${now.toISOString().slice(0, 10)}-${commit.slice(0, 7)}.json`);
  const temp = path.join(dir, `.${prefix}${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  try {
    linkSync(temp, file); // EEXIST if the name was taken meanwhile
  } finally {
    unlinkSync(temp);
  }
  const after = verifyHistory(dir);
  if (after.length) {
    unlinkSync(file);
    throw new Error(`Another record took sequence ${seq} at the same time; nothing was written.\n- ${after.join('\n- ')}`);
  }
  return { file, record };
}

/**
 * Append-only against a git ref: compared with the point where this branch left `base`, the only allowed change
 * to the history directory is a new file. A modified, deleted, renamed or type-changed file is reported. It
 * compares against the merge base, so a `base` that has moved ahead since the branch started is not a false
 * alarm. The base ref must be fetched (a shallow clone without it fails). The hash chain alone cannot catch a
 * rewrite that re-hashes every later record, or the removal of the newest record; this does.
 * @param {string} dir
 * @param {string} base a git ref such as origin/main
 * @param {{ cwd?: string }} [options]
 * @returns {string[]}
 */
export function verifyAppendOnly(dir, base, { cwd = process.cwd() } = {}) {
  const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const output = execFileSync('git', ['diff', '--name-status', '--no-renames', mergeBase, '--', path.resolve(cwd, dir)], { cwd, encoding: 'utf8' });
  const problems = [];
  for (const line of output.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    if (status === 'A') continue;
    const what = status === 'D' ? 'deleted' : status === 'M' ? 'modified' : `changed (git status ${status})`;
    problems.push(`${rest.join('\t')}: ${what} since ${base}; history files are only ever added`);
  }
  return problems;
}

/** The fields that make two records comparable like for like. */
const COMPARABLE = /** @type {const} */ (['questionSet', 'corpus', 'graderVersion', 'repeats']);

/** @param {Record<string, any>} record */
const questionIds = (record) => record.questions.map((/** @type {any} */ q) => q.id).sort().join('\n');

/**
 * What changed between two records: questions whose pass rate moved, the settings that differ, the latency shift,
 * and which comparability fields differ. A different question set, corpus, grader, repeat count, set of questions
 * run, or a stopped or partly unrun record means a score difference may not be the agent.
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
export function compareRecords(a, b) {
  const before = new Map(a.questions.map((/** @type {any} */ q) => [q.id, q]));
  const regressed = [];
  const improved = [];
  for (const q of b.questions) {
    const was = /** @type {any} */ (before.get(q.id));
    if (!was || was.passRate === q.passRate) continue;
    (q.passRate < was.passRate ? regressed : improved).push({ id: q.id, category: q.category, from: was.passRate, to: q.passRate, failedChecks: q.failedChecks });
  }
  const keys = [...new Set([...Object.keys(a.config), ...Object.keys(b.config)])].sort();
  const configChanges = keys.filter((k) => canonicalJson(a.config[k]) !== canonicalJson(b.config[k])).map((key) => ({ key, from: a.config[key] ?? null, to: b.config[key] ?? null }));
  const delta = (/** @type {number | null} */ x, /** @type {number | null} */ y) => (x === null || y === null || x === undefined || y === undefined ? null : y - x);
  const notComparable = [
    ...COMPARABLE.filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k])),
    ...(questionIds(a) === questionIds(b) ? [] : ['coverage']),
    ...((a.stopped ?? null) !== (b.stopped ?? null) || a.summary.notRun !== b.summary.notRun ? ['completeness'] : []),
  ];
  return {
    from: { seq: a.seq, commit: a.commit },
    to: { seq: b.seq, commit: b.commit },
    passRateDelta: round4(b.summary.passRate - a.summary.passRate),
    regressed,
    improved,
    configChanges,
    commitChanged: a.commit !== b.commit,
    latency: { medianDeltaMs: delta(a.latency?.medianMs, b.latency?.medianMs), p90DeltaMs: delta(a.latency?.p90Ms, b.latency?.p90Ms) },
    notComparable,
  };
}
