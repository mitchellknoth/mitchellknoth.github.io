// Eval runner (#17): asks every question in the set against a local `wrangler dev` copy of the agent and
// records the raw HTTP responses. It speaks only the public HTTP contract (POST /agent/session, then
// POST /agent/ask), exactly as the chat island does, so it grades what a visitor would get.
import { createHash } from 'node:crypto';
import { gradeResponse, indexCorpus, summarizeResults } from './grade.mjs';

export const RUN_SCHEMA_VERSION = 1;
const SESSION_COOKIE = '__Host-agent_session';
const MAX_RAW_BODY = 4000;

/** @typedef {import('./grade.mjs').Question} Question */
/** @typedef {{ baseUrl: string, kind: 'local' }} Target */
/**
 * @typedef {{ questionId: string, askedAt: string, latencyMs: number, httpStatus: number | null, body: any, error: string | null }} AskRecord
 */

/**
 * Evals run only against a local `wrangler dev` server, never a deployed Worker. A deployed target, even a
 * non-production hostname, shares the Guard and session Durable Objects with visitors, so an eval run would
 * use up the visitor request limits, and an eval-gateway 429 would pause the agent for every visitor. (Preview
 * version URLs are not an option either: Cloudflare doesn't generate them for Workers with Durable Objects.)
 * @param {string} baseUrl
 * @param {{ localHosts: string[] }} config
 * @returns {Target}
 */
export function assertEvalTarget(baseUrl, config) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Eval target must be http(s): ${baseUrl}`);
  if (!config.localHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`Evals run only against a local wrangler dev server (${config.localHosts.join(', ')}), not ${url.hostname}. See evals/README.md.`);
  }
  return { baseUrl: url.origin, kind: 'local' };
}

/** @param {unknown} error */
const describe = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** @param {Response} response */
async function readBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, MAX_RAW_BODY) };
  }
}

/** @param {Response} response */
function sessionCookie(response) {
  const headers = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
  for (const header of headers) {
    const pair = header.split(';')[0]?.trim() ?? '';
    if (pair.startsWith(`${SESSION_COOKIE}=`)) return pair;
  }
  return null;
}

/** Responses that mean every later question would fail too: the agent is offline, paused or has blocked us. */
const STOPS_RUN = new Set([403, 503]);

/**
 * Asks every question in order, each in a fresh session: answers never depend on an earlier question
 * (an injection attempt can't leak into the next answer), and the per-session message limit never trips.
 * @param {{ baseUrl: string, questions: Question[], fetch: typeof fetch, timeoutMs: number }} options
 * @returns {Promise<{ records: AskRecord[], stopped: string | null }>}
 */
export async function askAll({ baseUrl, questions, fetch: fetchImpl, timeoutMs }) {
  const origin = new URL(baseUrl).origin;
  /** @type {AskRecord[]} */
  const records = [];
  for (const question of questions) {
    const askedAt = new Date();
    const started = performance.now();
    /** @param {Partial<AskRecord>} fields @returns {AskRecord} */
    const record = (fields) => ({
      questionId: question.id,
      askedAt: askedAt.toISOString(),
      latencyMs: Math.round(performance.now() - started),
      httpStatus: null,
      body: null,
      error: null,
      ...fields,
    });

    /** @param {string} path @param {RequestInit} init */
    const post = (path, init) =>
      fetchImpl(new URL(path, origin), {
        ...init,
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });

    let result;
    try {
      const session = await post('/agent/session', {});
      const cookie = session.status === 201 ? sessionCookie(session) : null;
      if (!cookie) {
        const body = await readBody(session);
        result = record({ httpStatus: session.status === 201 ? null : session.status, body, error: `session: ${session.status === 201 ? 'no session cookie' : `HTTP ${session.status}`}` });
      } else {
        const answer = await post('/agent/ask', { headers: { cookie }, body: JSON.stringify({ question: question.question }) });
        result = record({ httpStatus: answer.status, body: await readBody(answer) });
      }
    } catch (error) {
      result = record({ error: describe(error) });
    }
    records.push(result);

    if (result.httpStatus !== null && STOPS_RUN.has(result.httpStatus)) {
      return { records, stopped: `HTTP ${result.httpStatus} ${result.body?.state ?? result.body?.error ?? ''}`.trim() };
    }
  }
  return { records, stopped: null };
}

/** @param {unknown} value */
const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/**
 * Grades the records and assembles one dated scorecard. The shape is versioned (`schemaVersion`) because
 * the "how this works" page renders these files.
 * @param {{
 *   questions: Question[], questionSetVersion?: number, questionSetStatus?: string, corpus: { documents: any[], entries: any[] },
 *   records: AskRecord[], stopped: string | null, model: string, target: Target, versions: Record<string, string>,
 *   declaredAiGateway?: string | null, startedAt: Date, finishedAt: Date
 * }} options
 */
export function createRun(options) {
  const { questions, corpus, records, stopped, model, target, versions, startedAt, finishedAt } = options;
  const index = indexCorpus(corpus);
  const byId = new Map(records.map((r) => [r.questionId, r]));
  const results = questions.map((question) => {
    const response = byId.get(question.id) ?? null;
    const base = { questionId: question.id, category: question.category, question: question.question, expected: question.expected };
    if (!response) return { ...base, outcome: /** @type {const} */ ('not_run'), checks: {}, error: null, response: null };
    const grade = gradeResponse(question, { httpStatus: response.httpStatus, body: response.body, error: response.error ?? undefined }, index);
    return { ...base, outcome: grade.outcome, checks: grade.checks, error: grade.error ?? null, response };
  });

  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    date: startedAt.toISOString().slice(0, 10),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    model,
    target,
    // What evals/config.json says the server was started with. The runner can't observe the gateway itself;
    // `npm run evals:serve` is what makes it true.
    declaredAiGateway: options.declaredAiGateway ?? null,
    versions,
    questionSet: {
      version: options.questionSetVersion ?? null,
      status: options.questionSetStatus ?? null,
      count: questions.length,
      sha256: sha256(questions),
    },
    corpus: { documents: corpus.documents.length, entries: corpus.entries.length, sha256: sha256({ documents: corpus.documents, entries: corpus.entries }) },
    stopped,
    summary: summarizeResults(results),
    results,
  };
}
