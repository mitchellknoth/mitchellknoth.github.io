// npm run evals:history -- <command>
//   export --scorecard evals/results/<date>/<model>.json     append a record from a scorecard
//   export --harbor experiments/harbor/jobs/<job> --model M  append a record from a Harbor job
//   verify [--base origin/main]                              check the hash chain (and append-only vs a git ref)
//   list                                                     one line per record
//   compare <seqA> <seqB>                                    what moved between two records
//
// Records live in evals/history/ (override with --dir). See evals/README.md, "Benchmark history".
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { appendRecord, compareRecords, corpusSha256, currentConfig, readHarborJob, readHistory, recordFiles, recordFromHarbor, recordFromScorecard, questionSetSha256, verifyAppendOnly, verifyHistory } from './history.mjs';
import { validateRun } from './results.mjs';

const USAGE = `Usage: npm run evals:history -- <command> [options]

  export --scorecard <file>             Append a record from an eval scorecard (evals/results/...)
  export --harbor <job dir> --model <m> Append a record from a Harbor job directory
  verify [--base <git ref>]             Check the hash chain; with --base also that no history file changed or went away
  list                                  One line per record
  compare <seqA> <seqB>                 Pass-rate, per-question and latency changes between two records

  --dir <path>      History directory (default evals/history)
  --allow-dirty     Export from a checkout with uncommitted changes; the record is marked dirty
  --commit <sha>    Commit the run was made at (Harbor export; default: git HEAD)`;

/** @param {string} cwd */
const gitOut = (cwd, /** @type {string[]} */ ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * Uncommitted changes to the code under test. The files an export reads and writes (scorecards, history) are
 * excluded, or a just-run scorecard would always make the checkout look dirty.
 * @param {string} rootDir
 */
const hasUncommittedChanges = (rootDir) => gitOut(rootDir, 'status', '--porcelain', '--', '.', ':!evals/history', ':!evals/results') !== '';

const pct = (/** @type {number} */ n) => `${Math.round(n * 1000) / 10}%`;
const signed = (/** @type {number | null} */ n, unit = '') => (n === null ? 'n/a' : `${n > 0 ? '+' : ''}${n}${unit}`);

/**
 * @param {string[]} argv
 * @param {{ console?: Pick<Console, 'log' | 'error'>, rootDir?: string, now?: () => Date, isDirty?: (rootDir: string) => boolean, headCommit?: (rootDir: string) => string }} [io]
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv, io = {}) {
  const { console: out = globalThis.console, rootDir = process.cwd(), now = () => new Date(), isDirty = hasUncommittedChanges, headCommit = (root) => gitOut(root, 'rev-parse', 'HEAD') } = io;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      scorecard: { type: 'string' },
      harbor: { type: 'string' },
      model: { type: 'string' },
      commit: { type: 'string' },
      base: { type: 'string' },
      'allow-dirty': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    out.log(USAGE);
    return values.help ? 0 : 1;
  }
  const dir = path.resolve(rootDir, values.dir ?? 'evals/history');

  if (command === 'export') {
    if (!values.scorecard === !values.harbor) throw new Error(`export needs exactly one of --scorecard or --harbor.\n\n${USAGE}`);
    const dirty = isDirty(rootDir);
    if (dirty && !values['allow-dirty']) throw new Error('The checkout has uncommitted changes, so a record could not say which code ran. Commit first, or pass --allow-dirty to record it as dirty.');
    /** @type {Record<string, any>} */
    let body;
    if (values.scorecard) {
      if (values.model || values.commit) throw new Error('--model and --commit apply to --harbor only: a scorecard records its own model and commit.');
      const run = readJson(path.resolve(rootDir, values.scorecard));
      const invalid = validateRun(run);
      if (invalid.length) throw new Error(`${values.scorecard} is not a valid scorecard:\n- ${invalid.join('\n- ')}`);
      // The config is read from this checkout, so the checkout must be the code that ran.
      const head = headCommit(rootDir);
      if (run.versions?.commit !== head) throw new Error(`The scorecard ran at commit ${String(run.versions?.commit).slice(0, 7)} but this checkout is at ${head.slice(0, 7)}; the record's config would describe the wrong code. Check out the run's commit and export again.`);
      body = recordFromScorecard(run, { config: currentConfig(rootDir, { model: run.model }), dirty });
    } else {
      if (!values.model?.trim()) throw new Error('--model is required with --harbor: the agent API does not report which model answered.');
      const set = readJson(path.join(rootDir, 'evals/question-set.json'));
      const corpus = readJson(path.join(rootDir, 'generated/corpus.json'));
      const job = await readHarborJob(path.resolve(rootDir, /** @type {string} */ (values.harbor)));
      body = recordFromHarbor(job, {
        config: currentConfig(rootDir, { model: values.model.trim() }),
        // Harbor records neither the commit, the corpus nor the question set, so they are taken from this checkout:
        // export right after the run, from the checkout it ran against.
        commit: values.commit ?? headCommit(rootDir),
        dirty,
        questionSet: { version: set.version ?? null, count: set.questions.length, sha256: questionSetSha256(set.questions) },
        corpusSha256: corpusSha256(corpus),
        questions: set.questions.map((/** @type {any} */ q) => ({ id: q.id, category: q.category })),
      });
    }
    const { file, record } = appendRecord(dir, body, { now: now() });
    out.log(`Wrote ${path.relative(rootDir, file)}: ${record.summary.passed}/${record.summary.trials} passed (${pct(record.summary.passRate)}), hash ${record.hash.slice(0, 12)}`);
    return 0;
  }

  if (command === 'verify') {
    const problems = [...verifyHistory(dir), ...(values.base ? verifyAppendOnly(dir, values.base, { cwd: rootDir }) : [])];
    if (problems.length) {
      out.error(`History at ${path.relative(rootDir, dir)} is not intact:\n- ${problems.join('\n- ')}`);
      return 1;
    }
    out.log(`History at ${path.relative(rootDir, dir)} is intact (${recordFiles(dir).length} records).`);
    return 0;
  }

  const problems = verifyHistory(dir);
  if (problems.length) throw new Error(`History at ${path.relative(rootDir, dir)} is not intact; run verify.\n- ${problems.join('\n- ')}`);
  const records = readHistory(dir);
  if (command === 'list') {
    for (const r of records) {
      out.log(`${String(r.seq).padStart(4, '0')}  ${r.recordedAt.slice(0, 10)}  ${String(r.commit).slice(0, 7)}  ${r.source}  ${r.config.model} effort=${r.config.effort} maxTurns=${r.config.maxTurns}  ${r.summary.passed}/${r.summary.trials} (${pct(r.summary.passRate)})  median ${r.latency.medianMs ?? 'n/a'} ms`);
    }
    return 0;
  }

  if (command === 'compare') {
    const [a, b] = args.map((n) => records.find((r) => r.seq === Number(n)));
    if (!a || !b) throw new Error('compare needs two sequence numbers that exist, e.g. compare 1 2');
    const d = compareRecords(a, b);
    out.log(`Compare ${String(a.seq).padStart(4, '0')} (${String(a.commit).slice(0, 7)}) -> ${String(b.seq).padStart(4, '0')} (${String(b.commit).slice(0, 7)})`);
    out.log(`Pass rate: ${pct(a.summary.passRate)} -> ${pct(b.summary.passRate)} (${signed(Math.round(d.passRateDelta * 1000) / 10, ' pts')})`);
    out.log(`Median latency: ${signed(d.latency.medianDeltaMs, ' ms')}; p90: ${signed(d.latency.p90DeltaMs, ' ms')}`);
    for (const c of d.configChanges) out.log(`Config ${c.key}: ${c.from} -> ${c.to}`);
    if (d.notComparable.length) out.log(`Not like for like: ${d.notComparable.join(', ')} differ, so a score change may not be the agent.`);
    for (const q of d.regressed) out.log(`Regressed ${q.id}: ${pct(q.from)} -> ${pct(q.to)}${q.failedChecks.length ? ` (${q.failedChecks.join(', ')})` : ''}`);
    for (const q of d.improved) out.log(`Improved ${q.id}: ${pct(q.from)} -> ${pct(q.to)}`);
    return 0;
  }

  throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
