import { describe, expect, it } from 'vitest';
import { interpretAsk, interpretHealth, interpretSession } from '../../src/lib/agent/contract';

// The HTTP contract is defined in the epic-13 plan note and implemented by worker/index.ts.
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, body, headers: new Headers(headers) });

describe('interpretHealth', () => {
  it('reads online and paused from a 200', () => {
    expect(interpretHealth(json(200, { state: 'online' }))).toEqual({ kind: 'online' });
    expect(interpretHealth(json(200, { state: 'paused' }))).toEqual({ kind: 'paused' });
  });

  it('reads the kill switch as offline', () => {
    expect(interpretHealth(json(503, { state: 'offline' }))).toEqual({ kind: 'offline' });
  });

  it('treats a host with no agent, and anything outside the contract, as absent', () => {
    // Static hosting without the Worker (GitHub Pages, before the Workers cutover) answers /agent/health with the 404 page.
    expect(interpretHealth(json(404, '<!doctype html>'))).toEqual({ kind: 'absent' });
    expect(interpretHealth(json(200, { state: 'nonsense' }))).toEqual({ kind: 'absent' });
    expect(interpretHealth(json(503, 'Service Unavailable'))).toEqual({ kind: 'absent' });
    expect(interpretHealth(null)).toEqual({ kind: 'absent' });
  });

  it('reports an edge challenge as unverified', () => {
    expect(interpretHealth(json(403, '<html>', { 'cf-mitigated': 'challenge' }))).toEqual({ kind: 'unverified' });
  });

  it('treats the edge rate limit page as an agent that exists, not as an absent one', () => {
    // Cloudflare's Error 1015 is a 429 with an HTML body. The visitor is going too fast; the agent is there.
    expect(interpretHealth(json(429, '<!doctype html><title>Error 1015</title>'))).toEqual({ kind: 'online' });
  });
});

describe('edge rate limit (Cloudflare Error 1015)', () => {
  const page = '<!doctype html><title>Error 1015</title>';

  it('is a throttled ask, never the agent’s own message limit', () => {
    expect(interpretAsk(json(429, page))).toEqual({ type: 'throttled' });
    expect(interpretAsk(json(429, { state: 'limit', reason: 'session_message_limit' }))).toEqual({ type: 'state', state: { kind: 'limit' } });
  });

  it('keeps a sensible Retry-After and ignores the rest', () => {
    expect(interpretAsk(json(429, page, { 'retry-after': '10' }))).toEqual({ type: 'throttled', retryAfterSeconds: 10 });
    expect(interpretAsk(json(429, page, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toEqual({ type: 'throttled' });
    expect(interpretAsk(json(429, page, { 'retry-after': '99999' }))).toEqual({ type: 'throttled' });
    expect(interpretAsk(json(429, page, { 'retry-after': '0' }))).toEqual({ type: 'throttled' });
  });

  it('applies to starting a session too', () => {
    expect(interpretSession(json(429, page, { 'retry-after': '5' }))).toEqual({ type: 'throttled', retryAfterSeconds: 5 });
  });
});

describe('interpretAsk', () => {
  it('passes an answered reply through with its same-origin sources', () => {
    const body = {
      status: 'answered',
      text: 'Team Brain is a shared repository.',
      sources: [{ id: 'project/team-brain#the-problem', title: 'Team Brain: the problem', url: '/work/team-brain/#the-problem' }],
    };
    expect(interpretAsk(json(200, body))).toEqual({ type: 'reply', body });
  });

  it('drops sources that are not same-origin paths', () => {
    const outcome = interpretAsk(json(200, {
      status: 'answered',
      text: 'x',
      sources: [
        { id: 'a', title: 'ok', url: '/about/' },
        { id: 'b', title: 'offsite', url: 'https://example.com/' },
        { id: 'c', title: 'protocol-relative', url: '//example.com/' },
        { id: 'd', title: 'script', url: 'javascript:alert(1)' },
        { id: 'e', title: 'not a string', url: 7 },
        // Browsers strip tabs and newlines from URLs, so these would resolve to https://evil.example/.
        { id: 'f', title: 'tab', url: '/\t/evil.example' },
        { id: 'g', title: 'newline', url: '/\n/evil.example' },
        { id: 'h', title: 'backslash', url: '/\\evil.example' },
        { id: 'i', title: 'space', url: '/ /evil.example' },
      ],
    }));
    expect(outcome.type === 'reply' && outcome.body.status === 'answered' && outcome.body.sources.map((s) => s.id)).toEqual(['a']);
  });

  // Copied from REFUSAL_TEXT in worker/reply.ts, which is what main serves. The Worker can't be imported
  // here: its corpus module reads generated/corpus.json, which exists only after a build.
  const WORKER_REFUSALS = {
    'not-in-corpus':
      'That is not in the corpus of Mitch’s published projects, essays and résumé, so I won’t guess. Try asking about one of his projects or essays.',
    personal:
      'I don’t answer personal questions about Mitch. I can tell you about his projects, his writing and his professional experience.',
    'social-engineering':
      'I can’t help with that. I only answer questions about Mitch’s published work, and I can’t act or speak for him.',
    'prompt-injection': 'I can’t change how I work. Ask me about Mitch’s projects, essays or professional experience.',
  };

  it('passes every refusal the Worker sends through, with its fixed text', () => {
    for (const [refusal, text] of Object.entries(WORKER_REFUSALS)) {
      const refused = { status: 'refused', refusal, text };
      expect(interpretAsk(json(200, refused))).toEqual({ type: 'reply', body: refused });
    }
  });

  it('passes the unanswered reasons the Worker sends through', () => {
    for (const reason of ['empty_answer', 'model_error', 'unknown']) {
      const unanswered = { status: 'unanswered', reason };
      expect(interpretAsk(json(200, unanswered))).toEqual({ type: 'reply', body: unanswered });
    }
  });

  it('treats a malformed 200 as an error', () => {
    expect(interpretAsk(json(200, { status: 'answered' }))).toEqual({ type: 'error' });
    expect(interpretAsk(json(200, { status: 'refused', refusal: 'other', text: 'x' }))).toEqual({ type: 'error' });
    expect(interpretAsk(json(200, 'ok'))).toEqual({ type: 'error' });
  });

  it('maps every refusal state in the contract', () => {
    expect(interpretAsk(json(503, { state: 'offline' }))).toEqual({ type: 'state', state: { kind: 'offline' } });
    expect(interpretAsk(json(503, { state: 'paused', until: '2026-11-06T00:00:00.000Z' }))).toEqual({
      type: 'state',
      state: { kind: 'paused', until: '2026-11-06T00:00:00.000Z' },
    });
    expect(interpretAsk(json(403, { state: 'blocked', until: '2026-11-05T18:00:00.000Z' }))).toEqual({
      type: 'state',
      state: { kind: 'blocked', until: '2026-11-05T18:00:00.000Z' },
    });
    expect(interpretAsk(json(429, { state: 'limit', reason: 'session_message_limit' }))).toEqual({ type: 'state', state: { kind: 'limit' } });
    expect(interpretAsk(json(502, { state: 'error' }))).toEqual({ type: 'error' });
    expect(interpretAsk(json(401, { error: 'no_session' }))).toEqual({ type: 'no-session' });
    expect(interpretAsk(json(413, { error: 'question_too_long', maxChars: 1000 }))).toEqual({ type: 'too-long', maxChars: 1000 });
    expect(interpretAsk(json(400, { error: 'empty_question' }))).toEqual({ type: 'error' });
  });

  it('ignores an until that is not a date', () => {
    expect(interpretAsk(json(503, { state: 'paused', until: 'soon' }))).toEqual({ type: 'state', state: { kind: 'paused' } });
  });

  it('reports an edge challenge as unverified, and other 403s as errors', () => {
    expect(interpretAsk(json(403, '<html>', { 'cf-mitigated': 'challenge' }))).toEqual({ type: 'state', state: { kind: 'unverified' } });
    expect(interpretAsk(json(403, { error: 'cross_origin' }))).toEqual({ type: 'error' });
  });

  it('treats a failed request as an error', () => {
    expect(interpretAsk(null)).toEqual({ type: 'error' });
    expect(interpretAsk(json(500, 'Internal Server Error'))).toEqual({ type: 'error' });
  });
});

describe('interpretSession', () => {
  it('accepts a created session and maps refusals', () => {
    expect(interpretSession(json(201, { state: 'online' }))).toEqual({ type: 'ok' });
    expect(interpretSession(json(503, { state: 'offline' }))).toEqual({ type: 'state', state: { kind: 'offline' } });
    expect(interpretSession(json(403, { error: 'cross_origin' }))).toEqual({ type: 'error' });
    expect(interpretSession(null)).toEqual({ type: 'error' });
  });
});
