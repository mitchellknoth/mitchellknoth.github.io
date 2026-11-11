// The benchmark workflow (Part of #16) spends money and holds a Cloudflare token, so its shape is a contract:
// who can trigger it, where the token goes, what it may commit, and that only one benchmark PR exists at a time.
// Read as text because the repo has no YAML dependency.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { verifyHistory } from '../../scripts/evals/history.mjs';

const rootDir = process.cwd();
const read = (/** @type {string} */ file) => readFileSync(path.join(rootDir, file), 'utf8');
const workflow = read('.github/workflows/benchmark.yml');

/** The text of one step, from its `- name:` line to the next step. @param {string} name */
function step(name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `step "${name}" exists`);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test('the workflow runs only when someone dispatches it, and only from main', () => {
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(triggers, /workflow_dispatch:/);
  for (const other of ['schedule', 'push', 'pull_request', 'pull_request_target', 'workflow_run', 'issue_comment']) {
    assert.ok(!new RegExp(`^  ${other}:`, 'm').test(triggers), `no ${other} trigger: a live run costs money and uses the token`);
  }
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/, 'a dispatch from any other ref does not run, even if the environment is unprotected');
});

test('the token lives in one protected environment and is passed to one step only', () => {
  assert.match(workflow, /environment:\s*\n?\s*(name: )?cloudflare-evals\b/);
  const uses = [...workflow.matchAll(/secrets\.CLOUDFLARE_API_TOKEN/g)];
  assert.equal(uses.length, 1, 'the eval token is referenced exactly once');
  assert.match(step('Serve the agent locally and run the evals'), /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /secrets\.(?!CLOUDFLARE_API_TOKEN)/, 'no other secret is used');
});

test('permissions start read-only; the job adds only what opening a pull request needs', () => {
  const top = workflow.slice(workflow.indexOf('\npermissions:'), workflow.indexOf('\nconcurrency:'));
  assert.match(top, /contents: read/);
  assert.doesNotMatch(top, /: write/);
  const job = workflow.slice(workflow.indexOf('    permissions:'), workflow.indexOf('    steps:'));
  assert.match(job, /contents: write/);
  assert.match(job, /pull-requests: write/);
  assert.equal([...job.matchAll(/: (read|write)/g)].length, 2, 'no other permission is granted');
});

test('runs are serialised and a second benchmark PR cannot be opened while one is waiting', () => {
  assert.match(workflow, /concurrency:\s*\n\s*group: benchmark-history\s*\n\s*cancel-in-progress: false/);
  const guard = step('Refuse while a benchmark record is waiting to merge');
  assert.match(guard, /gh pr list .*--label benchmark-record .*--state open/);
  assert.match(guard, /exit 1/);
});

test('the history is verified before and after, and only the history directory is committed', () => {
  assert.match(step('Check the history chain is intact'), /evals:history -- verify/);
  const open = step('Open a pull request with the record');
  assert.match(open, /git add evals\/history\b/);
  assert.doesNotMatch(open, /git add (-A|\.|--all)/);
  assert.match(open, /evals:history -- verify/, 'the new chain is verified before it is pushed');
  assert.match(open, /--label benchmark-record/);
  assert.match(open, /--base main/);
  assert.doesNotMatch(workflow, /--force|git push .*--delete|gh pr merge|--auto/, 'the workflow never force-pushes or merges');
});

test('the scorecard (which holds answers) is kept as a short-lived artifact, not committed', () => {
  const upload = step('Keep the scorecard');
  assert.match(upload, /path: evals\/results/);
  assert.match(upload, /retention-days: \d+/);
});

test('pull requests are checked for an append-only history against their base', () => {
  const quality = read('.github/workflows/quality.yml');
  assert.match(quality, /fetch-depth: 0/);
  assert.match(quality, /evals:history -- verify --base origin\/\$\{\{ github\.base_ref \}\}/);
});

test('the committed history, if there is any, is an intact chain', () => {
  assert.deepEqual(verifyHistory(path.join(rootDir, 'evals/history')), []);
});
