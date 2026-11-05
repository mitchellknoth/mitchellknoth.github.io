// Scorecard files (#17): one JSON run file plus a short Markdown summary per run, under
// evals/results/<YYYY-MM-DD>/<model-slug>.json. Runs are history: a second run of the same model on the
// same day gets a numbered file instead of replacing the first.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RUN_SCHEMA_VERSION } from './run.mjs';

const OUTCOMES = new Set(['pass', 'fail', 'error', 'not_run']);

/** "@cf/meta/llama-4-scout" -> "cf-meta-llama-4-scout" */
export const modelSlug = (/** @type {string} */ model) =>
  model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Lists what is wrong with a scorecard, so committed results and the page that renders them can trust its shape.
 * @param {any} run
 * @returns {string[]}
 */
export function validateRun(run) {
  const problems = [];
  if (run?.schemaVersion !== RUN_SCHEMA_VERSION) return [`schemaVersion must be ${RUN_SCHEMA_VERSION}`];
  if (typeof run.model !== 'string' || !run.model) problems.push('model must be a non-empty string');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(run.date ?? '')) problems.push('date must be YYYY-MM-DD');
  for (const field of ['startedAt', 'finishedAt']) {
    if (Number.isNaN(Date.parse(run[field]))) problems.push(`${field} must be an ISO timestamp`);
  }
  if (!['local', 'preview'].includes(run.target?.kind)) problems.push('target.kind must be "local" or "preview"');
  if (typeof run.versions !== 'object' || run.versions === null) problems.push('versions must be an object');
  if (!Array.isArray(run.results)) return [...problems, 'results must be an array'];
  run.results.forEach((/** @type {any} */ result, /** @type {number} */ i) => {
    if (typeof result.questionId !== 'string') problems.push(`results[${i}].questionId missing`);
    if (typeof result.category !== 'string') problems.push(`results[${i}].category missing`);
    if (!OUTCOMES.has(result.outcome)) problems.push(`results[${i}].outcome must be one of ${[...OUTCOMES].join(', ')}`);
  });
  const summary = run.summary ?? {};
  if (summary.total !== run.results.length) problems.push('summary.total must equal the number of results');
  if (typeof summary.passRate !== 'number' || summary.passRate < 0 || summary.passRate > 1) problems.push('summary.passRate must be between 0 and 1');
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
    `- AI Gateway: ${run.aiGateway ?? 'not recorded'}`,
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
    const base = path.join(dir, n === 1 ? slug : `${slug}-${n}`);
    try {
      // `wx` fails if the file exists, so two runs can never overwrite each other.
      await writeFile(`${base}.json`, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') continue;
      throw error;
    }
    await writeFile(`${base}.md`, renderSummary(run));
    return { json: `${base}.json`, summary: `${base}.md` };
  }
}
