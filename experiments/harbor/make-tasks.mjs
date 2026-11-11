// Turns questions from evals/question-set.json into Harbor task directories under tasks/ (gitignored).
// One per category by default; pass ids to choose: node make-tasks.mjs answerable-001 numeric-trap-003
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const set = JSON.parse(readFileSync(`${root}evals/question-set.json`, 'utf8'));
const defaults = ['answerable-001', 'unanswerable-001', 'personal-or-social-engineering-001', 'numeric-trap-001', 'prompt-injection-002'];
const ids = process.argv.length > 2 ? process.argv.slice(2) : defaults;

rmSync(`${here}tasks`, { recursive: true, force: true });
for (const id of ids) {
  const question = set.questions.find((q) => q.id === id);
  if (!question) throw new Error(`no question ${id}`);
  const dir = `${here}tasks/${id}`;
  for (const sub of ['environment', 'tests']) mkdirSync(`${dir}/${sub}`, { recursive: true });
  writeFileSync(`${dir}/instruction.md`, `${question.question}\n`);
  writeFileSync(`${dir}/environment/Dockerfile`, 'FROM node:24-slim\n\nWORKDIR /app\n');
  writeFileSync(
    `${dir}/task.toml`,
    `schema_version = "1.4"
artifacts = []

[task]
name = "mitch/${id}"
version = "1.0.0"
description = "Agent eval question ${id} (${question.category}), graded by the repo's deterministic grader."
authors = []
keywords = ["agent-eval", "${question.category}"]

[metadata]

[verifier]
timeout_sec = 120.0
environment_mode = "shared"
collect = []

[verifier.env]

[agent]
timeout_sec = 300.0

[environment]
network_mode = "public"
build_timeout_sec = 600.0
os = "linux"
mcp_servers = []

[environment.env]

[solution.env]
`,
  );
  writeFileSync(`${dir}/tests/test.sh`, '#!/bin/bash\nnode /tests/grade-one.mjs /app/answer.json /tests/question.json /tests/corpus.json\n', { mode: 0o755 });
  writeFileSync(`${dir}/tests/question.json`, JSON.stringify(question, null, 1));
  copyFileSync(`${root}generated/corpus.json`, `${dir}/tests/corpus.json`);
  copyFileSync(`${root}scripts/evals/grade.mjs`, `${dir}/tests/grade.mjs`);
  copyFileSync(`${here}verifier/grade-one.mjs`, `${dir}/tests/grade-one.mjs`);
}
console.log(`wrote ${ids.length} task(s) to experiments/harbor/tasks`);
