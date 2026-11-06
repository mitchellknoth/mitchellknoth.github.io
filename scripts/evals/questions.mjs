// Question-set validation (#14, #17), shared by `npm run test:build` and the eval runner, so a set the
// runner accepts is exactly a set the build accepts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

export const REFUSALS = ['not-in-corpus', 'personal', 'social-engineering', 'prompt-injection'];

/**
 * Lists every problem with a question set. `categories` rules apply when the set declares them (the
 * committed set always does); `corpusIds` and `maxChars` apply when given.
 * @param {{ categories?: Record<string, { allowedExpectations: string[], allowedRefusals?: string[] }>, questions?: unknown }} set
 * @param {{ corpusIds?: Set<string>, maxChars?: number }} [options]
 * @returns {string[]}
 */
export function validateQuestions(set, { corpusIds, maxChars } = {}) {
  if (!Array.isArray(set.questions)) return ['questions must be a list'];
  const problems = [];
  const ids = new Set();
  for (const [i, raw] of set.questions.entries()) {
    const q = /** @type {any} */ (raw ?? {});
    const name = typeof q.id === 'string' ? q.id : `questions[${i}]`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(q.id ?? '')) problems.push(`${name}: bad question id`);
    if (ids.has(q.id)) problems.push(`${name}: duplicate question id`);
    ids.add(q.id);

    const category = set.categories?.[q.category];
    if (typeof q.category !== 'string' || (set.categories && !category)) problems.push(`${name}: unknown category ${q.category}`);
    if (typeof q.question !== 'string' || !q.question.trim()) problems.push(`${name}: missing question text`);
    else if (maxChars && q.question.length > maxChars) problems.push(`${name}: question too long (${q.question.length} > ${maxChars} characters)`);

    const expected = q.expected ?? {};
    const kinds = ['sources', 'refusal'].filter((kind) => expected[kind] !== undefined);
    if (kinds.length !== 1) {
      problems.push(`${name}: expected needs exactly one of sources or refusal`);
    } else if (category && !category.allowedExpectations.includes(kinds[0])) {
      problems.push(`${name}: ${q.category} does not allow ${kinds[0]}`);
    } else if (kinds[0] === 'sources') {
      if (!Array.isArray(expected.sources) || expected.sources.length === 0) problems.push(`${name}: sources must be a non-empty list`);
      else for (const id of expected.sources) if (corpusIds && !corpusIds.has(id)) problems.push(`${name}: ${id} is not in the corpus`);
    } else {
      const allowed = category ? category.allowedRefusals ?? [] : REFUSALS;
      if (!allowed.includes(expected.refusal)) problems.push(`${name}: refusal ${expected.refusal} not allowed for ${q.category}`);
    }

    // Optional, for prompt-injection questions: text that appears in an answer only if the agent obeyed.
    if (q.forbidden !== undefined) {
      if (q.category !== 'prompt-injection') problems.push(`${name}: forbidden applies only to prompt-injection questions`);
      if (!Array.isArray(q.forbidden) || q.forbidden.length === 0 || !q.forbidden.every((/** @type {unknown} */ m) => typeof m === 'string' && m.trim())) {
        problems.push(`${name}: forbidden must be a non-empty list of non-empty strings`);
      }
    }
  }
  return problems;
}

/**
 * The agent's question length limit (`MAX_PROMPT_CHARS` in wrangler.jsonc). A longer question would come
 * back as HTTP 413 and be scored as an error instead of testing the model.
 * @param {string} rootDir
 */
export function maxPromptChars(rootDir) {
  /** @type {import('jsonc-parser').ParseError[]} */
  const errors = [];
  const config = parseJsonc(readFileSync(path.join(rootDir, 'wrangler.jsonc'), 'utf8'), errors, { allowTrailingComma: true });
  const value = Number.parseInt(config?.vars?.MAX_PROMPT_CHARS ?? '', 10);
  if (errors.length || !Number.isFinite(value) || value <= 0) throw new Error('wrangler.jsonc must set vars.MAX_PROMPT_CHARS');
  return value;
}
