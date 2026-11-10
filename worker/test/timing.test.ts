import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import { SESSION_COOKIE } from '../session-cookie';
import { createTimer, serverTimingHeader, summarizeRounds, type AskTiming } from '../timing';

// Phase timing (#16): durations and token counts only. Nothing here may carry a question, an answer, an IP address
// or a session name. Offline: no model is called.

const ORIGIN = 'https://mitchellknoth.com';
const SESSION = '0b6b2c1e-8f4a-4c3e-9d2a-5e7f1a2b3c4d';

const SECRET_QUESTION = 'zebra-quartz-question-text';
const SECRET_ANSWER = 'walrus-answer-text';

function user(text: string) {
  return { kind: 'pi.user', model: [{ role: 'user', content: text }] };
}
function assistant(
  startedAt: number,
  durationMs: number | undefined,
  usage: { input: number; output: number; reasoning?: number; cacheRead?: number },
  content: unknown[],
  stopReason = 'stop',
) {
  return {
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        timestamp: startedAt,
        durationMs,
        stopReason,
        content,
        usage: { cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...usage },
      },
    ],
  };
}
const toolCall = { type: 'toolCall', id: 'c1', name: 'search_corpus', arguments: { query: SECRET_QUESTION } };
const text = { type: 'text', text: SECRET_ANSWER };
const toolResult = { kind: 'pi.tool-result', model: [{ role: 'toolResult', content: [{ type: 'text', text: SECRET_ANSWER }] }] };

describe('summarizeRounds', () => {
  it('reports each model round of the latest question: duration, tokens, tool calls and the gap before it', () => {
    const rounds = summarizeRounds([
      user('an earlier question'),
      assistant(500, 100, { input: 1, output: 1 }, [text]),
      user(SECRET_QUESTION),
      assistant(1_000, 4_000, { input: 900, output: 300, reasoning: 250 }, [toolCall], 'toolUse'),
      toolResult,
      assistant(5_100, 6_500, { input: 2_400, output: 700, reasoning: 640, cacheRead: 800 }, [text]),
    ]);
    expect(rounds).toEqual([
      { ms: 4_000, input: 900, output: 300, reasoning: 250, cacheRead: 0, stop: 'toolUse', toolCalls: 1 },
      { ms: 6_500, input: 2_400, output: 700, reasoning: 640, cacheRead: 800, stop: 'stop', toolCalls: 0, gapMs: 100 },
    ]);
  });

  it('never carries message text, tool arguments or answers', () => {
    const rounds = summarizeRounds([
      user(SECRET_QUESTION),
      assistant(1_000, 10, { input: 1, output: 1 }, [toolCall, text]),
    ]);
    const serialized = JSON.stringify(rounds);
    expect(serialized).not.toContain(SECRET_QUESTION);
    expect(serialized).not.toContain(SECRET_ANSWER);
  });

  it('survives entries it does not understand', () => {
    expect(summarizeRounds([])).toEqual([]);
    expect(summarizeRounds([{ kind: 'pi.assistant' }, { kind: 'pi.assistant', model: [null, 3, {}] }])).toEqual([]);
    expect(summarizeRounds([user('q'), assistant(1, undefined, { input: 5, output: 2 }, [text])])).toEqual([
      { input: 5, output: 2, cacheRead: 0, stop: 'stop', toolCalls: 0 },
    ]);
  });
});

describe('createTimer', () => {
  it('records each phase, the total and what the agent run spent outside the model rounds', async () => {
    let now = 1_000;
    const timer = createTimer(() => now);
    await timer.time('start', async () => {
      now += 30;
    });
    await timer.time('agent', async () => {
      now += 12_000;
    });
    timer.rounds = [
      { ms: 5_000, input: 1, output: 1, cacheRead: 0, stop: 'toolUse', toolCalls: 1 },
      { ms: 6_000, input: 1, output: 1, cacheRead: 0, stop: 'stop', toolCalls: 0, gapMs: 50 },
    ];
    now += 5;
    expect(timer.finish({ status: 'answered', text: 't', sources: [] }, { model: 'm', effort: 'max' })).toEqual({
      outcome: 'answered',
      totalMs: 12_035,
      phases: { start: 30, agent: 12_000 },
      agentOverheadMs: 1_000,
      model: 'm',
      effort: 'max',
      rounds: timer.rounds,
    });
  });

  it('names the reason when a run ends unanswered or a session is limited', () => {
    const timer = createTimer(() => 0);
    expect(timer.finish({ status: 'unanswered', reason: 'turn_limit' }, { model: 'm', effort: 'low' })).toMatchObject({
      outcome: 'unanswered',
      reason: 'turn_limit',
    });
    expect(timer.finish({ status: 'limit', reason: 'session_message_limit' }, { model: 'm', effort: 'low' })).toMatchObject({
      outcome: 'limit',
      reason: 'session_message_limit',
    });
    expect(timer.finish({ status: 'refused', refusal: 'personal', text: 'x' }, { model: 'm', effort: 'low' })).toMatchObject({
      outcome: 'refused',
    });
  });
});

describe('serverTimingHeader', () => {
  it('lists the Worker and session phases and each model round', () => {
    const timing: AskTiming = {
      outcome: 'answered',
      totalMs: 9_000,
      phases: { start: 12, intent: 310, agent: 8_500 },
      agentOverheadMs: 40,
      model: 'm',
      effort: 'max',
      rounds: [{ ms: 4_000, input: 900, output: 300, reasoning: 250, cacheRead: 0, stop: 'toolUse', toolCalls: 1 }],
    };
    const header = serverTimingHeader({ admit: 7, session: 9_050, total: 9_060 }, timing);
    expect(header).toContain('admit;dur=7');
    expect(header).toContain('session;dur=9050');
    expect(header).toContain('total;dur=9060');
    expect(header).toContain('intent;dur=310');
    expect(header).toContain('agent;dur=8500');
    expect(header).toContain('round1;dur=4000;desc="in=900 out=300 reasoning=250 tools=1"');
    expect(header).not.toMatch(/[^\x20-\x7e]/);
  });

  it('works without session timing', () => {
    expect(serverTimingHeader({ admit: 1, session: 2, total: 3 })).toBe('admit;dur=1, session;dur=2, total;dur=3');
  });
});

describe('the session object', () => {
  it('returns timings only when asked, with an agent phase for a question that reaches the agent', async () => {
    const stub = env.VISITOR_SESSION.getByName(crypto.randomUUID());
    const limits = { maxMessages: 20, ttlSeconds: 86_400 };
    // Passes the regex screen; offline the agent cannot answer, so the run ends unanswered.
    const question = 'Could you tell me what the person behind this site does on weekends?';
    expect(await stub.ask(question, limits)).not.toHaveProperty('timing');
    const timed = await stub.ask(question, { ...limits, timing: true });
    expect(timed).toMatchObject({ status: 'unanswered' });
    expect(timed.timing).toMatchObject({ outcome: 'unanswered', model: env.AGENT_MODEL, rounds: expect.any(Array) });
    expect(Object.keys(timed.timing?.phases ?? {})).toEqual(expect.arrayContaining(['start', 'agent']));
  });
});

describe('logging and the HTTP response', () => {
  afterEach(() => vi.restoreAllMocks());

  function ask(question: string, vars: Record<string, string>, ip = '198.51.100.77') {
    return worker.fetch(
      new Request(`${ORIGIN}/agent/ask`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${crypto.randomUUID()}`,
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify({ question }),
      }),
      { ...env, ...vars },
    );
  }

  it('sends Server-Timing only when TIMING_HEADER is "true", and never puts timing in the body', async () => {
    const off = await ask('How old is Mitch?', { TIMING_HEADER: 'false' });
    expect(off.headers.get('server-timing')).toBeNull();
    expect(await off.json()).toEqual({ status: 'refused', refusal: 'personal', text: expect.any(String) });

    const on = await ask('How old is Mitch?', { TIMING_HEADER: 'true' });
    const header = on.headers.get('server-timing') ?? '';
    expect(header).toMatch(/admit;dur=\d/);
    expect(header).toMatch(/start;dur=\d/);
    expect(header).toMatch(/total;dur=\d/);
    expect(await on.json()).toEqual({ status: 'refused', refusal: 'personal', text: expect.any(String) });
  });

  it('logs one content-free timing line per question: no question, no IP, no session name', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sessionName = crypto.randomUUID();
    const question = `${SECRET_QUESTION} how old is Mitch?`;
    await worker.fetch(
      new Request(`${ORIGIN}/agent/ask`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${sessionName}`,
          'cf-connecting-ip': '203.0.113.99',
        },
        body: JSON.stringify({ question }),
      }),
      { ...env, TIMING_HEADER: 'false' },
    );
    const lines = log.mock.calls.map((call) => String(call[0]));
    const events = lines.map((line) => JSON.parse(line) as { event: string });
    expect(events.map((e) => e.event).sort()).toEqual(['agent_request', 'ask_timing']);
    const all = lines.join('\n');
    expect(all).not.toContain(SECRET_QUESTION);
    expect(all).not.toContain('203.0.113.99');
    expect(all).not.toContain(sessionName);
    const ask = events.find((e) => e.event === 'ask_timing') as unknown as AskTiming & { event: string };
    expect(ask).toMatchObject({ outcome: 'refused', model: env.AGENT_MODEL });
    expect(ask.phases).toHaveProperty('start');
    expect(ask.phases).not.toHaveProperty('agent');
  });
});
