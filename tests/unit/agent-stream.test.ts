import { describe, expect, it } from 'vitest';
import { interpretAsk } from '../../src/lib/agent/contract';
import { parseStreamLine, readAskStream } from '../../src/lib/agent/stream';

// The streamed form of POST /agent/ask (#16, option A): newline-delimited JSON with status and ping events, then
// one `final` event that carries the HTTP status and body the plain JSON response would have had.

const encoder = new TextEncoder();
const lines = (...events: unknown[]) => events.map((event) => `${JSON.stringify(event)}\n`).join('');

/** A byte stream that delivers `chunks` in order, then ends (or stays open when `hang` is set). */
function bodyOf(chunks: string[], hang = false): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!));
      else if (!hang) controller.close();
      else return new Promise(() => {});
    },
  });
}

const ANSWER = { status: 'answered', text: 'It is a shared memory.', sources: [{ id: 'a', title: 'A', url: '/work/a/' }] };

describe('parseStreamLine', () => {
  it('reads status, ping and final events', () => {
    expect(parseStreamLine('{"type":"status","phase":"searching"}')).toEqual({ type: 'status', phase: 'searching' });
    expect(parseStreamLine('{"type":"ping"}')).toEqual({ type: 'ping' });
    expect(parseStreamLine('{"type":"final","status":200,"body":{"a":1}}')).toEqual({ type: 'final', status: 200, body: { a: 1 } });
  });

  it('ignores what the contract does not describe', () => {
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('not json')).toBeNull();
    expect(parseStreamLine('{"type":"surprise"}')).toBeNull();
    expect(parseStreamLine('{"type":"status","phase":"sleeping"}')).toBeNull();
    expect(parseStreamLine('{"type":"final","status":"200","body":{}}')).toBeNull();
    expect(parseStreamLine('[1,2]')).toBeNull();
  });
});

describe('readAskStream', () => {
  it('reports each phase in order and returns the final event as the response it stands for', async () => {
    const phases: string[] = [];
    const received = await readAskStream(
      bodyOf([lines({ type: 'status', phase: 'checking' }, { type: 'status', phase: 'searching' }, { type: 'ping' }, { type: 'final', status: 200, body: ANSWER })]),
      { onPhase: (phase) => phases.push(phase) },
    );
    expect(phases).toEqual(['checking', 'searching']);
    expect(interpretAsk(received)).toEqual({ type: 'reply', body: ANSWER });
  });

  it('puts a line back together when a chunk splits it, even inside a multi-byte character', async () => {
    const whole = lines({ type: 'final', status: 200, body: { ...ANSWER, text: 'Café – résumé' } });
    const bytes = encoder.encode(whole);
    const cut = whole.indexOf('é') + 1; // between the two bytes of é
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const outcome = interpretAsk(await readAskStream(stream, {}));
    expect(outcome).toMatchObject({ type: 'reply', body: { text: 'Café – résumé' } });
  });

  it('maps a streamed refusal state exactly like the plain response', async () => {
    const received = await readAskStream(bodyOf([lines({ type: 'final', status: 429, body: { state: 'limit', reason: 'session_message_limit' } })]), {});
    expect(interpretAsk(received)).toEqual({ type: 'state', state: { kind: 'limit' } });
    const noSession = await readAskStream(bodyOf([lines({ type: 'final', status: 401, body: { error: 'no_session' } })]), {});
    expect(interpretAsk(noSession)).toEqual({ type: 'no-session' });
  });

  it('is a failed request when the stream ends without a final event', async () => {
    expect(await readAskStream(bodyOf([lines({ type: 'status', phase: 'searching' })]), {})).toBeNull();
    expect(await readAskStream(bodyOf([]), {})).toBeNull();
  });

  it('is a failed request when nothing, not even a ping, arrives within the idle limit', async () => {
    const started = Date.now();
    const received = await readAskStream(bodyOf([lines({ type: 'status', phase: 'checking' })], true), { idleMs: 60 });
    expect(received).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keeps waiting while pings keep arriving', async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 4; i += 1) {
          controller.enqueue(encoder.encode(lines({ type: 'ping' })));
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        controller.enqueue(encoder.encode(lines({ type: 'final', status: 200, body: ANSWER })));
        controller.close();
      },
    });
    expect(interpretAsk(await readAskStream(stream, { idleMs: 100 }))).toMatchObject({ type: 'reply' });
  });

  it('skips malformed and unknown lines instead of failing', async () => {
    const received = await readAskStream(bodyOf(['garbage\n', lines({ type: 'surprise' }), lines({ type: 'final', status: 200, body: ANSWER })]), {});
    expect(interpretAsk(received)).toMatchObject({ type: 'reply' });
  });
});
