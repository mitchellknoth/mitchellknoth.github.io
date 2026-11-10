import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { describeResult, streamResponse, wantsStream } from '../ask-response';
import worker from '../index';
import type { AskResult } from '../session';
import { SESSION_COOKIE } from '../session-cookie';

// The streamed form of POST /agent/ask (#16, option A; src/lib/agent/stream.ts describes it for the island).
// Offline: a screened question never reaches the model, so the whole stream can be read without one.

const ORIGIN = 'https://mitchellknoth.com';
const NDJSON = 'application/x-ndjson';

function ask(question: unknown, init: { accept?: string; cookie?: string | null; vars?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.88' };
  if (init.accept) headers.accept = init.accept;
  const cookie = init.cookie === undefined ? `${SESSION_COOKIE}=${crypto.randomUUID()}` : init.cookie;
  if (cookie) headers.cookie = cookie;
  return worker.fetch(new Request(`${ORIGIN}/agent/ask`, { method: 'POST', headers, body: JSON.stringify({ question }) }), { ...env, ...init.vars });
}

async function events(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('wantsStream', () => {
  it('is true only when the client asks for newline-delimited JSON', () => {
    const request = (accept?: string) => new Request(`${ORIGIN}/agent/ask`, { method: 'POST', headers: accept ? { accept } : {} });
    expect(wantsStream(request(NDJSON))).toBe(true);
    expect(wantsStream(request(`${NDJSON}, application/json;q=0.5`))).toBe(true);
    expect(wantsStream(request('application/json'))).toBe(false);
    expect(wantsStream(request('*/*'))).toBe(false);
    expect(wantsStream(request())).toBe(false);
  });
});

describe('describeResult', () => {
  const now = Date.UTC(2026, 10, 10, 15, 0, 0);
  it('gives every result the status and body the plain JSON response has', () => {
    const answered: AskResult = { status: 'answered', text: 't', sources: [] };
    expect(describeResult(answered, now)).toEqual({ status: 200, body: answered });
    expect(describeResult({ status: 'limit', reason: 'session_message_limit' }, now)).toEqual({
      status: 429,
      body: { state: 'limit', reason: 'session_message_limit' },
    });
    expect(describeResult({ status: 'expired' }, now)).toEqual({ status: 401, body: { error: 'no_session' } });
  });

  it('turns a spent budget into a pause until the next UTC midnight', () => {
    const until = Date.UTC(2026, 10, 11);
    expect(describeResult({ status: 'budget', reason: 'inference_budget' }, now)).toEqual({
      status: 503,
      body: { state: 'paused', until: new Date(until).toISOString() },
      pauseUntil: until,
    });
  });
});

describe('POST /agent/ask as a stream', () => {
  it('answers a screened question with status events and one final event carrying the plain JSON status and body', async () => {
    const response = await ask('How old is Mitch?', { accept: NDJSON });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(NDJSON);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const list = await events(response);
    expect(list[0]).toEqual({ type: 'status', phase: 'checking' });
    expect(list.at(-1)).toMatchObject({ type: 'final', status: 200, body: { status: 'refused', refusal: 'personal' } });
    expect(list.filter((event) => event.type === 'final')).toHaveLength(1);
  });

  it('answers the same question exactly as before when the client does not ask for a stream', async () => {
    const response = await ask('How old is Mitch?', { accept: 'application/json' });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ status: 'refused', refusal: 'personal' });
  });

  it('streams the session message limit as a final event with its HTTP status', async () => {
    const cookie = `${SESSION_COOKIE}=${crypto.randomUUID()}`;
    const vars = { MAX_MESSAGES_PER_SESSION: '1', TIMING_HEADER: 'false' };
    await (await ask('How old is Mitch?', { accept: NDJSON, cookie, vars })).text();
    const list = await events(await ask('How old is Mitch?', { accept: NDJSON, cookie, vars }));
    expect(list.at(-1)).toEqual({ type: 'final', status: 429, body: { state: 'limit', reason: 'session_message_limit' } });
  });

  it('keeps the checks before the run as plain JSON errors, even when a stream was asked for', async () => {
    const noSession = await ask('What has Mitch built?', { accept: NDJSON, cookie: null });
    expect(noSession.status).toBe(401);
    expect(noSession.headers.get('content-type')).toContain('application/json');
    const tooLong = await ask('x'.repeat(1_001), { accept: NDJSON });
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toMatchObject({ error: 'question_too_long' });
    const empty = await ask('  ', { accept: NDJSON });
    expect(empty.status).toBe(400);
  });

  it('adds the Server-Timing figures to the final event only when TIMING_HEADER is "true"', async () => {
    const on = await events(await ask('How old is Mitch?', { accept: NDJSON, vars: { TIMING_HEADER: 'true' } }));
    expect(on.at(-1)).toMatchObject({ type: 'final', serverTiming: expect.stringMatching(/admit;dur=\d/) });
    const off = await events(await ask('How old is Mitch?', { accept: NDJSON, vars: { TIMING_HEADER: 'false' } }));
    expect(off.at(-1)).not.toHaveProperty('serverTiming');
  });
});

describe('streamResponse', () => {
  const encoder = new TextEncoder();
  const line = (event: unknown) => encoder.encode(`${JSON.stringify(event)}\n`);

  it('pings while the session is still working, then ends with the settled final event', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(line({ type: 'status', phase: 'searching' }));
        await new Promise((resolve) => setTimeout(resolve, 130));
        controller.enqueue(line({ type: 'result', result: { status: 'answered', text: 'ok', sources: [] } }));
        controller.close();
      },
    });
    const response = streamResponse(upstream, async (result) => ({ status: 200, body: result }), 25);
    const list = await events(response);
    expect(list[0]).toEqual({ type: 'status', phase: 'searching' });
    expect(list.filter((event) => event.type === 'ping').length).toBeGreaterThanOrEqual(2);
    expect(list.at(-1)).toEqual({ type: 'final', status: 200, body: { status: 'answered', text: 'ok', sources: [] } });
  });

  it('reports a run that ended without a result as a failed run, with no stack trace', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(line({ type: 'status', phase: 'checking' }));
        controller.close();
      },
    });
    const response = streamResponse(upstream, async (result) => (result ? { status: 200, body: result } : { status: 502, body: { state: 'error' } }), 1_000);
    expect((await events(response)).at(-1)).toEqual({ type: 'final', status: 502, body: { state: 'error' } });
  });

  it('only passes on the phases the contract names', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(line({ type: 'status', phase: 'daydreaming' }));
        controller.enqueue(line({ type: 'result', result: { status: 'expired' } }));
        controller.close();
      },
    });
    const list = await events(streamResponse(upstream, async () => ({ status: 401, body: { error: 'no_session' } }), 1_000));
    expect(list.filter((event) => event.type === 'status')).toEqual([]);
  });
});
