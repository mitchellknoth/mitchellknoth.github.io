// Scorecard files (#17): one JSON run file plus a short Markdown summary per run, under
// evals/results/<YYYY-MM-DD>/<model-slug>.json. Runs are history: a second run of the same model on the
// same day gets a numbered file (<model-slug>--2.json) instead of replacing the first. A slug never contains
// "--", so a numbered run can't collide with another model's name.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RUN_SCHEMA_VERSION } from './run.mjs';

/** "@cf/meta/llama-4-scout" -> "cf-meta-llama-4-scout" */
export const modelSlug = (/** @type {string} */ model) =>
  model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const isObject = (/** @type {unknown} */ value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (/** @type {unknown} */ value) => Number.isInteger(value) && /** @type {number} */ (value) >= 0;

/**
 * Lists what is wrong with a scorecard, so committed results and the page that renders them can trust its shape.
 * @param {any} run
 * @returns {string[]}
 */
export function validateRun(run) {
  if (run?.schemaVersion !== RUN_SCHEMA_VERSION) return [`schemaVersion must be ${RUN_SCHEMA_VERSION}`];
  const problems = [];
  if (typeof run.model !== 'string' || !run.model) problems.push('model must be a non-empty string');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(run.date ?? '')) problems.push('date must be YYYY-MM-DD');
  for (const field of ['startedAt', 'finishedAt']) {
    if (Number.isNaN(Date.parse(run[field]))) problems.push(`${field} must be an ISO timestamp`);
  }
  if (run.target?.kind !== 'local' || typeof run.target?.baseUrl !== 'string') problems.push('target must be { baseUrl, kind: "local" }');
  if (!isObject(run.versions) || !Object.values(run.versions).every((v) => typeof v === 'string')) problems.push('versions must map names to version strings');
  if (!isObject(run.questionSet) || !isCount(run.questionSet.count) || typeof run.questionSet.sha256 !== 'string') problems.push('questionSet must record count and sha256');
  if (!isObject(run.corpus) || !isCount(run.corpus.documents) || !isCount(run.corpus.entries) || typeof run.corpus.sha256 !== 'string') problems.push('corpus must record documents, entries and sha256');
  if (run.stopped !== null && typeof run.stopped !== 'string') problems.push('stopped must be null or a reason');
  if (!Array.isArray(run.results)) return [...problems, 'results must be an array'];

  const tally = { pass: 0, fail: 0, error: 0, not_run: 0 };
  run.results.forEach((/** @type {any} */ result, /** @type {number} */ i) => {
    const at = `results[${i}]`;
    if (typeof result.questionId !== 'string') problems.push(`${at}.questionId missing`);
    if (typeof result.category !== 'string') problems.push(`${at}.category missing`);
    if (!Object.hasOwn(tally, result.outcome)) {
      problems.push(`${at}.outcome must be one of ${Object.keys(tally).join(', ')}`);
    } else {
      tally[/** @type {keyof typeof tally} */ (result.outcome)] += 1;
    }
    if (!isObject(result.checks) || !Object.values(result.checks).every((c) => isObject(c) && typeof c.pass === 'boolean' && typeof c.detail === 'string')) {
      problems.push(`${at}.checks must map names to { pass, detail }`);
    } else if (result.outcome === 'pass' && !Object.values(result.checks).every((c) => c.pass)) {
      problems.push(`${at} passes with a failed check`);
    }
    if (result.outcome !== 'not_run' && !isObject(result.response)) problems.push(`${at}.response missing`);
  });

  const s = run.summary ?? {};
  const counts = { total: run.results.length, passed: tally.pass, failed: tally.fail, errors: tally.error, notRun: tally.not_run };
  for (const [field, value] of Object.entries(counts)) {
    if (s[field] !== value) problems.push(`summary.${field} must be ${value}`);
  }
  if (typeof s.passRate !== 'number' || Math.abs(s.passRate - (counts.total ? counts.passed / counts.total : 0)) > 1e-4) problems.push('summary.passRate must be passed / total');
  if (!isObject(s.byCategory) || !isObject(s.byCheck)) problems.push('summary must include byCategory and byCheck');
  return problems;
}

const percent = (/** @type {number} */ rate) => `${Math.round(rate * 1000) / 10}%`;

/**
 * A short human-readable summary of one run, committed next to its JSON.
 * @param {ReturnType<typeof import('./run.mjs').createRun>} run
 */
export function renderSummary(run) {
  const { summary } = run;
  const versions = Object.entries(run.versions).map(([name, version]) => `${name} ${version}`).join(', ') || 'not recorded';
  const lines = [
    `# Eval run: ${run.model} (${run.date})`,
    '',
    `**${summary.passed} of ${summary.total} passed (${percent(summary.passRate)}).** ${summary.failed} failed, ${summary.errors} errors, ${summary.notRun} not run.`,
    '',
    `- Target: ${run.target.kind} (${run.target.baseUrl})`,
    `- AI Gateway (declared): ${run.declaredAiGateway ?? 'not recorded'}`,
    `- Versions: ${versions}`,
    `- Question set: ${run.questionSet.count} questions, version ${run.questionSet.version ?? '?'}, ${run.questionSet.status ?? 'unknown status'}`,
    `- Corpus: ${run.corpus.documents} documents, ${run.corpus.entries} entries, sha256 ${run.corpus.sha256.slice(0, 12)}`,
    ...(run.stopped ? [`- Stopped early: ${run.stopped}`] : []),
    '',
    '| Category | Passed | Failed | Errors | Not run |',
    '|---|---|---|---|---|',
    ...Object.entries(summary.byCategory).map(([name, c]) => `| ${name} | ${c.passed}/${c.total} | ${c.failed} | ${c.errors} | ${c.notRun} |`),
    '',
    '| Check | Passed |',
    '|---|---|',
    ...Object.entries(summary.byCheck).map(([name, c]) => `| ${name} | ${c.passed}/${c.applied} |`),
  ];
  const problems = run.results.filter((r) => r.outcome !== 'pass');
  if (problems.length) {
    lines.push('', '## Not passed', '');
    for (const result of problems) {
      const reasons = result.outcome === 'fail'
        ? Object.entries(result.checks).filter(([, c]) => !c.pass).map(([name, c]) => `${name}: ${c.detail}`).join('; ')
        : result.error ?? 'not run';
      lines.push(`- \`${result.questionId}\` (${result.outcome}): ${reasons}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Writes the run's JSON and Markdown summary without replacing an earlier run.
 * @param {ReturnType<typeof import('./run.mjs').createRun>} run
 * @param {string} resultsDir
 */
export async function writeRun(run, resultsDir) {
  const dir = path.join(resultsDir, run.date);
  await mkdir(dir, { recursive: true });
  const slug = modelSlug(run.model);
  for (let n = 1; ; n += 1) {
    const base = path.join(dir, n === 1 ? slug : `${slug}--${n}`);
    if (existsSync(`${base}.json`) || existsSync(`${base}.md`)) continue;
    try {
      // `wx` fails if the file appeared meanwhile, so two runs can never overwrite each other.
      await writeFile(`${base}.json`, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') continue;
      throw error;
    }
    await writeFile(`${base}.md`, renderSummary(run), { flag: 'wx' });
    return { json: `${base}.json`, summary: `${base}.md` };
  }
}
