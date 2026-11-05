// EVAL_MODEL=@cf/<vendor>/<model> npm run evals:serve        (one terminal)
// EVAL_MODEL=@cf/<vendor>/<model> npm run evals -- --base-url http://127.0.0.1:8787
//
// Asks the eval question set against a local `wrangler dev` copy of the agent, grades the answers
// deterministically and writes a dated scorecard under evals/results/. See evals/README.md.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { GRADER_VERSION, indexCorpus } from './grade.mjs';
import { maxPromptChars, validateQuestions } from './questions.mjs';
import { writeRun } from './results.mjs';
import { askAll, assertEvalTarget, createRun } from './run.mjs';

const USAGE = `Usage: npm run evals -- --base-url <url> [--model <@cf/model-id>] [options]

  --base-url     Local wrangler dev origin from npm run evals:serve, e.g. http://127.0.0.1:8787
  --model        The model the server runs (its AGENT_MODEL; default $EVAL_MODEL). The API does not report it
  --questions    Question set (default evals/question-set.json)
  --corpus       Corpus the target was built with (default generated/corpus.json, from npm run build)
  --out          Results directory (default evals/results)
  --timeout-ms   Per-request timeout (default from evals/config.json)`;

/** Package versions that define the agent under test, read from package.json. */
const AGENT_PACKAGES = ['agents', '@earendil-works/pi-ai', '@earendil-works/pi-durable', '@earendil-works/pi-schema'];

/** @param {string} file */
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/** @param {string} rootDir */
function gitCommit(rootDir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * @param {string[]} argv
 * @param {{ fetch?: typeof fetch, console?: Pick<Console, 'log' | 'error'>, now?: () => Date, rootDir?: string, env?: NodeJS.ProcessEnv }} [io]
 */
export async function main(argv, io = {}) {
  const { fetch: fetchImpl = globalThis.fetch, console: out = globalThis.console, now = () => new Date(), rootDir = process.cwd(), env = {} } = io;
  const { values } = parseArgs({
    args: argv,
    options: {
      'base-url': { type: 'string' },
      model: { type: 'string', default: env.EVAL_MODEL },
      questions: { type: 'string', default: path.join(rootDir, 'evals/question-set.json') },
      corpus: { type: 'string', default: path.join(rootDir, 'generated/corpus.json') },
      out: { type: 'string', default: path.join(rootDir, 'evals/results') },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    out.log(USAGE);
    return null;
  }
  if (!values['base-url']) throw new Error(`--base-url is required.\n\n${USAGE}`);
  if (!values.model?.trim()) throw new Error(`--model (or EVAL_MODEL) is required: the agent API does not report which model answered.\n\n${USAGE}`);

  const config = await readJson(path.join(rootDir, 'evals/config.json'));
  const target = assertEvalTarget(values['base-url'], config);
  const timeoutMs = Number(values['timeout-ms'] ?? config.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');

  const set = await readJson(values.questions);
  /** @type {import('./grade.mjs').Question[]} */
  const questions = Array.isArray(set.questions) ? set.questions : [];
  if (questions.length === 0) throw new Error(`${values.questions} has no questions yet; nothing to run.`);

  let corpus;
  try {
    corpus = await readJson(values.corpus);
  } catch (error) {
    throw new Error(`Cannot read the corpus at ${values.corpus}: run npm run build first. (${/** @type {Error} */ (error).message})`);
  }
  // Check everything before asking anything: grading against a different corpus than the set expects would
  // silently mark answers wrong, and an over-long question would only ever come back as an HTTP 413.
  const corpusIds = new Set(indexCorpus(corpus).keys());
  const problems = validateQuestions(set, { corpusIds, maxChars: maxPromptChars(rootDir) });
  if (problems.length) throw new Error(`${values.questions} is not runnable (corpus: ${values.corpus}):\n- ${problems.join('\n- ')}`);

  const pkg = await readJson(path.join(rootDir, 'package.json'));
  /** @type {Record<string, string>} */
  const versions = { harness: config.harnessVersion, grader: GRADER_VERSION, commit: gitCommit(rootDir) };
  for (const name of AGENT_PACKAGES) {
    const version = pkg.dependencies?.[name];
    if (version) versions[name] = version;
  }

  out.log(`Asking ${questions.length} questions at ${target.baseUrl} (${target.kind}) as ${values.model} ...`);
  const startedAt = now();
  const { records, stopped } = await askAll({ baseUrl: target.baseUrl, questions, fetch: fetchImpl, timeoutMs });
  const run = createRun({
    questions,
    questionSetVersion: set.version,
    questionSetStatus: set.status,
    corpus,
    records,
    stopped,
    model: values.model.trim(),
    target,
    versions,
    declaredAiGateway: config.aiGateway,
    startedAt,
    finishedAt: now(),
  });
  const files = await writeRun(run, values.out);
  const { summary } = run;
  out.log(`${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errors} errors, ${summary.notRun} not run.`);
  if (stopped) out.error(`Stopped early: ${stopped}`);
  out.log(`Wrote ${path.relative(rootDir, files.json)} and ${path.relative(rootDir, files.summary)}`);
  return { ...files, run };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { env: process.env }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
