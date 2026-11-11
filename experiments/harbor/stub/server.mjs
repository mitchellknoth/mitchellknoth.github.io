// A stand-in for the agent's HTTP contract (POST /agent/session, POST /agent/ask) so the Harbor plumbing can be
// tried with no model and no token. It answers from evals/question-set.json: the expected sources or refusal,
// except for the question ids in STUB_WRONG, which get a deliberately wrong answer to exercise the verifier's
// fail path. It sends a Server-Timing header in the Worker's format (worker/timing.ts).
// Usage: node stub/server.mjs   (PORT=8787, STUB_WRONG=id,id, STUB_DELAY_MS=200)
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { indexCorpus } from '../../../scripts/evals/grade.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const set = JSON.parse(readFileSync(`${root}evals/question-set.json`, 'utf8'));
const index = indexCorpus(JSON.parse(readFileSync(`${root}generated/corpus.json`, 'utf8')));
const byText = new Map(set.questions.map((q) => [q.question, q]));
const wrong = new Set((process.env.STUB_WRONG ?? '').split(',').filter(Boolean));
const delay = Number(process.env.STUB_DELAY_MS ?? 200);
const port = Number(process.env.PORT ?? 8787);

function answerFor(q) {
  if (wrong.has(q.id)) {
    // Wrong on purpose: an answer where a refusal is expected, and a refusal where sources are expected.
    return q.expected.sources
      ? { status: 'refused', refusal: 'not-in-corpus', text: 'I can only answer from the site.' }
      : { status: 'answered', text: 'Yes, definitely.', sources: [] };
  }
  if (q.expected.sources) {
    const sources = q.expected.sources.map((id) => ({ id, url: index.get(id).url, title: index.get(id).title }));
    return { status: 'answered', text: 'Stub answer.', sources };
  }
  return { status: 'refused', refusal: q.expected.refusal, text: 'I can only answer from the site.' };
}

createServer(async (req, res) => {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && req.url === '/agent/session') return send(201, { ok: true }, { 'set-cookie': '__Host-agent_session=stub; Path=/; HttpOnly' });
  if (req.method === 'POST' && req.url === '/agent/ask') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const q = byText.get(JSON.parse(raw || '{}').question);
    if (!q) return send(400, { error: 'unknown question' });
    await new Promise((r) => setTimeout(r, delay));
    const timing = `admit;dur=40, session;dur=${delay}, total;dur=${delay + 45}, round1;dur=${Math.round(delay / 2)};desc="in=3 out=40 reasoning=0 tools=1", round2;dur=${Math.round(delay / 2)};desc="in=3 out=92 reasoning=0 tools=0"`;
    return send(200, answerFor(q), { 'server-timing': timing });
  }
  return send(404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log(`stub agent on http://127.0.0.1:${port}`));
