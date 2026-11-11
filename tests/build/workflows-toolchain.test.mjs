// Every workflow gets Node from mise (mise.toml + mise.lock), the same pin used on a laptop, instead of a Node major
// named in each workflow. Read as text because the repo has no YAML dependency; `actionlint` covers syntax.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const rootDir = process.cwd();
const dir = path.join(rootDir, '.github/workflows');
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8') }));

test('no workflow installs Node itself, so mise.toml is the single pin', () => {
  for (const { file, text } of workflows) {
    assert.doesNotMatch(text, /actions\/setup-node|node-version:/, `${file}: Node comes from mise-action`);
  }
});

test('mise-action is pinned to a full commit SHA and installs only what CI needs', () => {
  let uses = 0;
  for (const { file, text } of workflows) {
    for (const m of text.matchAll(/uses: jdx\/mise-action@(\S+)/g)) {
      uses += 1;
      assert.match(m[1], /^[0-9a-f]{40}$/, `${file}: a third-party action is pinned by SHA, not by tag`);
    }
    for (const block of text.split(/uses: jdx\/mise-action@/).slice(1)) {
      assert.match(block.split('\n      - ')[0], /install_args: node\b/, `${file}: only Node is installed (uv is for the local Harbor spike)`);
    }
  }
  assert.ok(uses >= 5, 'every job that ran setup-node now runs mise-action');
});

test('jobs that deploy or hold a credential do not restore the tool cache', () => {
  for (const file of ['deploy.yml', 'benchmark.yml']) {
    const text = workflows.find((w) => w.file === file)?.text ?? '';
    const blocks = text.split(/uses: jdx\/mise-action@/).slice(1);
    assert.ok(blocks.length > 0, `${file} uses mise-action`);
    for (const block of blocks) assert.match(block.split('\n      - ')[0], /cache: false/, `${file}: mise-action cache is off`);
  }
});

test('the toolchain pins Node, and the lockfile covers the runner platform', () => {
  const toml = readFileSync(path.join(rootDir, 'mise.toml'), 'utf8');
  assert.match(toml, /^node = "24"/m);
  const lock = readFileSync(path.join(rootDir, 'mise.lock'), 'utf8');
  assert.match(lock, /\[tools\.node\."platforms\.linux-x64"\]/, 'ubuntu runners can verify the Node download against a checksum');
});
