// The benchmark workflow (Part of #16) spends money and holds a Cloudflare token, so its shape is a contract:
// who can trigger it, which job holds which credential, what it may push, and that only one benchmark PR
// exists at a time. Read as text because the repo has no YAML dependency; `actionlint` covers syntax.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { verifyHistory } from '../../scripts/evals/history.mjs';

const rootDir = process.cwd();
const read = (/** @type {string} */ file) => readFileSync(path.join(rootDir, file), 'utf8');
const workflow = read('.github/workflows/benchmark.yml');

/** The text of one job, from `  <id>:` to the next job (or the end). @param {string} id */
function job(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `job "${id}" exists`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The text of one step within a job. @param {string} jobId @param {string} name */
function step(jobId, name) {
  const text = job(jobId);
  const start = text.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `step "${name}" exists in ${jobId}`);
  const next = text.indexOf('\n      - name:', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

/** Every `run: |` block body in a file. @param {string} text */
const runBlocks = (text) => [...text.matchAll(/\n\s+run: \|\n((?:(?: {10,}.*)?\n)+)/g)].map((m) => m[1]);

test('the workflow runs only when someone dispatches it, and only from main', () => {
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(triggers, /workflow_dispatch:/);
  for (const other of ['schedule', 'push', 'pull_request', 'pull_request_target', 'workflow_run', 'issue_comment']) {
    assert.ok(!new RegExp(`^  ${other}:`, 'm').test(triggers), `no ${other} trigger: a live run costs money and uses the token`);
  }
  for (const id of ['evaluate', 'propose']) assert.match(job(id), /if: github\.ref == 'refs\/heads\/main'/, `${id} does not run from another ref`);
});

test('the eval token is held by the read-only job, in a protected environment, in one step', () => {
  const evaluate = job('evaluate');
  assert.match(evaluate, /environment: cloudflare-evals/);
  assert.match(evaluate, /permissions:\s*\n\s+contents: read\s*\n\s+pull-requests: read/);
  assert.doesNotMatch(evaluate, /: write/);
  assert.equal([...workflow.matchAll(/secrets\./g)].length, 1, 'exactly one secret reference in the workflow');
  assert.match(step('evaluate', 'Serve the agent locally and run the evals'), /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_EVAL_API_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /secrets: inherit|toJSON\(secrets\)/);
});

test('the job that can write holds no environment secret and stores no credential in the checkout', () => {
  const propose = job('propose');
  assert.doesNotMatch(propose, /environment:/);
  assert.doesNotMatch(propose, /secrets\./);
  assert.match(propose, /contents: write/);
  assert.match(propose, /pull-requests: write/);
  assert.equal([...propose.matchAll(/: (read|write)/g)].length, 2, 'no other permission is granted');
  for (const id of ['evaluate', 'propose']) {
    assert.match(step(id, 'Checkout'), /persist-credentials: false/, `${id}: the checkout token is not left in .git/config`);
  }
  const top = workflow.slice(workflow.indexOf('\npermissions:'), workflow.indexOf('\nconcurrency:'));
  assert.match(top, /contents: read/);
  assert.doesNotMatch(top, /: write/);
});

test('no expression is expanded inside a shell script, and the dispatch input only reaches env', () => {
  for (const file of ['.github/workflows/benchmark.yml', '.github/workflows/quality.yml']) {
    for (const block of runBlocks(read(file))) assert.doesNotMatch(block, /\$\{\{/, `${file}: a \${{ }} expression inside run: can inject shell`);
  }
  for (const line of workflow.split('\n').filter((l) => /\binputs\./.test(l))) assert.match(line, /^\s+INPUT_MODEL: \$\{\{ inputs\.model \}\}$/);
  assert.match(step('evaluate', 'Pick the model'), /\^\[A-Za-z0-9@\/\._:-\]\+\$/, 'the model name is validated');
});

test('runs are serialised and a second benchmark PR cannot be opened while one is waiting', () => {
  assert.match(workflow, /\nconcurrency:\s*\n\s+group: benchmark-history\s*\n\s+cancel-in-progress: false/);
  const guard = step('evaluate', 'Refuse while a benchmark record is waiting to merge');
  assert.match(guard, /gh pr list .*--label benchmark-record .*--state open/);
  assert.match(guard, /exit 1/);
});

test('the agent log stays outside the checkout, so the export sees a clean tree', () => {
  const serve = step('evaluate', 'Serve the agent locally and run the evals');
  assert.doesNotMatch(serve.replace(/\$RUNNER_TEMP\/serve\.log/g, ''), /serve\.log/, 'serve.log is only ever written under RUNNER_TEMP');
  assert.match(serve, /kill -0 "\$server"/, 'a server that died is noticed without waiting out the loop');
});

test('an incomplete run is not recorded', () => {
  const check = step('evaluate', 'Refuse an incomplete run');
  assert.match(check, /stopped/);
  assert.match(check, /errors/);
  assert.match(check, /notRun/);
  assert.match(check, /no scorecard was written/);
  const order = (/** @type {string} */ name) => job('evaluate').indexOf(`- name: ${name}`);
  assert.ok(order('Keep the scorecard') < order('Refuse an incomplete run'), 'the scorecard is kept even when the run is refused');
  assert.ok(order('Refuse an incomplete run') < order('Export the record'));
});

test('the record is passed between jobs as an artifact, so a failed pull request does not lose it', () => {
  assert.match(step('evaluate', 'Keep the scorecard'), /path: evals\/results[\s\S]*retention-days: \d+/);
  assert.match(step('evaluate', 'Keep the record'), /name: record/);
  assert.match(step('propose', 'Fetch the record'), /name: record/);
  assert.match(step('propose', 'Open a pull request with the record'), /benchmark\/run-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/, 'a re-run uses a new branch name');
});

test('only the history directory is committed, once verified, and the only push is the new branch', () => {
  const open = step('propose', 'Open a pull request with the record');
  assert.match(open, /git add evals\/history\b/);
  assert.doesNotMatch(open, /git add (-A|\.|--all)/);
  assert.doesNotMatch(workflow, /git add[^\n]*evals\/results/);
  const commit = open.indexOf('git commit');
  const verifyBase = open.indexOf('verify --base origin/main');
  const push = open.indexOf('git push');
  assert.ok(commit !== -1 && verifyBase > commit && push > verifyBase, 'append-only is verified after the commit (the record is then an added file) and before the push');
  for (const line of workflow.split('\n').filter((l) => /\bgit push\b/.test(l))) assert.match(line, /git push "https:\/\/x-access-token:\$\{GH_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git" "\$branch"$/);
  assert.match(open, /--base main/);
  assert.match(open, /--label benchmark-record/);
  assert.doesNotMatch(workflow, /--force|git push[^\n]*(\+|--delete)|gh pr merge|--auto/, 'the workflow never force-pushes or merges');
});

test('pull requests are checked for an append-only history against their base', () => {
  const quality = read('.github/workflows/quality.yml');
  assert.match(quality, /fetch-depth: 0/);
  assert.match(quality, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.match(quality, /evals:history -- verify --base "origin\/\$BASE_REF"/);
  assert.ok(quality.indexOf('verify --base') < quality.indexOf('npm run quality'), 'the cheap check runs before the long visual suite');
});

test('the committed history, if there is any, is an intact chain', () => {
  assert.deepEqual(verifyHistory(path.join(rootDir, 'evals/history')), []);
});
