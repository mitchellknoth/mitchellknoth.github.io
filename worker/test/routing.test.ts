import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../index';
import { SESSION_COOKIE } from '../session-cookie';
import { GUARD_NAME } from '../guard';
import { isBudgetRefusal, reasoningLevel } from '../session';

const ORIGIN = 'https://mitchellknoth.com';
const SESSION = '0b6b2c1e-8f4a-4c3e-9d2a-5e7f1a2b3c4d';
const LIMITS = { maxMessages: 20, ttlSeconds: 86_400 };

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ask(question: unknown, headers: Record<string, string> = {}) {
  return post('/agent/ask', { question }, { cookie: `${SESSION_COOKIE}=${SESSION}`, ...headers });
}

describe('static site', () => {
  it('serves pages from the assets binding', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('returns the 404 page for unknown paths', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/this-route-should-not-exist/`);
    expect(response.status).toBe(404);
  });
});

describe('kill switch', () => {
  it('answers every agent route with offline when AGENT_ENABLED is not "true"', async () => {
    const offline = { ...env, AGENT_ENABLED: 'false' };
    const response = await worker.fetch(new Request(`${ORIGIN}/agent/health`), offline);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state: 'offline' });
  });
});

describe('agent API', () => {
  it('reports health', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/agent/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects cross-origin and origin-less posts', async () => {
    expect((await post('/agent/session', undefined, { origin: 'https://example.com' })).status).toBe(403);
    const noOrigin = await exports.default.fetch(`${ORIGIN}/agent/session`, { method: 'POST' });
    expect(noOrigin.status).toBe(403);
  });

  it('issues a server-chosen session name only as an HttpOnly, Secure, SameSite=Strict cookie', async () => {
    const response = await post('/agent/session');
    expect(response.status).toBe(201);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[0-9a-f-]{36}; `));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(await response.json()).toEqual({ state: 'online' });
  });

  it('refuses questions without a well-formed session cookie', async () => {
    expect((await post('/agent/ask', { question: 'hi' })).status).toBe(401);
    const forged = await post('/agent/ask', { question: 'hi' }, { cookie: `${SESSION_COOKIE}=work-experience` });
    expect(forged.status).toBe(401);
  });

  it('validates the question before it reaches the guard or the model', async () => {
    expect((await ask('')).status).toBe(400);
    expect((await ask(42)).status).toBe(400);
    const tooLong = await ask('x'.repeat(1_001));
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toEqual({ error: 'question_too_long', maxChars: 1000 });
  });

  it('refuses a blocked address with 403 before any model call', async () => {
    await env.GUARD.getByName(GUARD_NAME).block('198.51.100.23', 60_000, 'test');
    const response = await ask('What has Mitch built?', { 'cf-connecting-ip': '198.51.100.23' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ state: 'blocked' });
  });

  it('refuses everyone with 503 while the agent is paused', async () => {
    const until = Date.now() + 60_000;
    await env.GUARD.getByName(GUARD_NAME).pause(until, 'test');
    const response = await ask('What has Mitch built?', { 'cf-connecting-ip': '198.51.100.24' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: 'paused' });
    const health = await exports.default.fetch(`${ORIGIN}/agent/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ state: 'paused', until: new Date(until).toISOString() });
  });

  it('allows only the documented methods and paths', async () => {
    expect((await exports.default.fetch(`${ORIGIN}/agent/ask`)).status).toBe(405);
    expect((await post('/agent/admin')).status).toBe(404);
  });
});

describe('session object', () => {
  // Starts Pi Durable inside the session object for real. The AI binding is offline in tests, so the model call
  // fails; what matters is that the harness opens, the failure is reported as a state, and nothing leaks.
  it('opens Pi and reports an unreachable model as unanswered instead of throwing', async () => {
    const session = env.VISITOR_SESSION.getByName(crypto.randomUUID());
    const result = await session.ask('What has Mitch built?', LIMITS);
    expect(result).toMatchObject({ status: 'unanswered' });
  }, 30_000);

  it('enforces the per-session message limit', async () => {
    const session = env.VISITOR_SESSION.getByName(crypto.randomUUID());
    expect(await session.ask('first', { ...LIMITS, maxMessages: 0 })).toEqual({
      status: 'limit',
      reason: 'session_message_limit',
    });
  });
});

describe('budget refusals', () => {
  it('recognises AI Gateway limit errors and nothing else', () => {
    expect(isBudgetRefusal('AiError: 429 Too Many Requests')).toBe(true);
    expect(isBudgetRefusal('Spend limit reached for gateway')).toBe(true);
    expect(isBudgetRefusal('500 Internal Server Error')).toBe(false);
    expect(isBudgetRefusal(undefined)).toBe(false);
  });
});

describe('reasoning effort', () => {
  it('uses the configured level and falls back to off for anything else', () => {
    expect(reasoningLevel('max')).toBe('max');
    expect(reasoningLevel('high')).toBe('high');
    expect(reasoningLevel('off')).toBe('off');
    expect(reasoningLevel(undefined)).toBe('off');
    expect(reasoningLevel('Max')).toBe('off');
    expect(reasoningLevel('ultra')).toBe('off');
  });

  it('ships the chosen model and a valid effort', () => {
    expect(env.AGENT_MODEL).toBe('openai/gpt-6-luna');
    expect(reasoningLevel(env.AGENT_REASONING)).toBe(env.AGENT_REASONING);
  });
});
