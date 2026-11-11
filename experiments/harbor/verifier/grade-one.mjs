// Runs inside the Harbor task container. Grades one answer with the repo's own deterministic grader
// (scripts/evals/grade.mjs, copied next to this file by make-tasks.mjs) so Harbor and `npm run evals` agree.
// Writes /logs/verifier/reward.txt (1 pass, 0 otherwise), reward.json and grade.json (every check's detail).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gradeResponse, indexCorpus, GRADER_VERSION } from './grade.mjs';

const [answerPath, questionPath, corpusPath] = process.argv.slice(2);
const out = '/logs/verifier';
mkdirSync(out, { recursive: true });

let grade;
try {
  const question = JSON.parse(readFileSync(questionPath, 'utf8'));
  const index = indexCorpus(JSON.parse(readFileSync(corpusPath, 'utf8')));
  const record = JSON.parse(readFileSync(answerPath, 'utf8'));
  grade = gradeResponse(question, { httpStatus: record.httpStatus, body: record.body, error: record.error ?? undefined }, index);
} catch (error) {
  grade = { outcome: 'error', checks: {}, error: `verifier could not grade: ${error.message}` };
}
const pass = grade.outcome === 'pass';
writeFileSync(`${out}/reward.txt`, pass ? '1' : '0');
writeFileSync(`${out}/reward.json`, JSON.stringify({ reward: pass ? 1 : 0 }));
writeFileSync(`${out}/grade.json`, JSON.stringify({ graderVersion: GRADER_VERSION, ...grade }, null, 1));
console.log(`${grade.outcome}${grade.error ? `: ${grade.error}` : ''}`);
