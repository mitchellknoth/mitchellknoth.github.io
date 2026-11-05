import { describe, expect, it } from 'vitest';
import { interpretAsk, interpretHealth, interpretSession } from '../../src/lib/agent/contract';

// The HTTP contract is defined in the epic-13 plan note and implemented by worker/index.ts.
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, body, headers: new Headers(headers) });

describe('interpretHealth', () => {
  it('reads online and paused from a 200', () => {
    expect(interpretHealth(json(200, { state: 'online' }))).toEqual({ kind: 'online' });
    expect(interpretHealth(json(200, { state: 'paused' }))).toEqual({ kind: 'paused' });
  });

  it('treats the kill switch, a missing route and garbage as offline', () => {
    expect(interpretHealth(json(503, { state: 'offline' }))).toEqual({ kind: 'offline' });
    // Static hosting without the Worker answers /agent/health with the 404 page.
    expect(interpretHealth(json(404, '<!doctype html>'))).toEqual({ kind: 'offline' });
    expect(interpretHealth(json(200, { state: 'nonsense' }))).toEqual({ kind: 'offline' });
    expect(interpretHealth(null)).toEqual({ kind: 'offline' });
  });

  it('reports an edge challenge as unverified', () => {
    expect(interpretHealth(json(403, '<html>', { 'cf-mitigated': 'challenge' }))).toEqual({ kind: 'unverified' });
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
      ],
    }));
    expect(outcome.type === 'reply' && outcome.body.status === 'answered' && outcome.body.sources.map((s) => s.id)).toEqual(['a']);
  });

  it('passes refusals and unanswered replies through', () => {
    const refused = { status: 'refused', refusal: 'personal', text: 'I only answer from published work.' };
    expect(interpretAsk(json(200, refused))).toEqual({ type: 'reply', body: refused });
    const unanswered = { status: 'unanswered', reason: 'model_error' };
    expect(interpretAsk(json(200, unanswered))).toEqual({ type: 'reply', body: unanswered });
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
