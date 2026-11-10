import { nextUtcMidnight } from './guard';
import type { AskResult, TimedAskResult } from './session';

// The two shapes of a `POST /agent/ask` answer (#16, option A). The plain one is a single JSON body. A client that
// sends `Accept: application/x-ndjson` gets the same answer as a stream of lines, so it sees where the work is while
// it waits and the connection never sits idle:
//
//   {"type":"status","phase":"checking" | "searching" | "writing"}
//   {"type":"ping"}                                    every PING_MS while waiting
//   {"type":"final","status":<http status>,"body":<the plain JSON body>}
//
// Everything before the run (cookie, body, length, admission) is still a plain JSON error with its own status, so
// the stream starts only for a question that will be answered. Status events say where the work is, never what the
// answer says: the answer is checked after the run (worker/reply.ts) and arrives only in `final`.
// src/lib/agent/stream.ts is the island's reader for this format.

export const NDJSON = 'application/x-ndjson';
/** How often a `ping` line is sent while the answer is not ready; it keeps the connection from sitting idle. */
export const PING_MS = 10_000;

const PHASES = ['checking', 'searching', 'writing'];

/** True when the client asked for the streamed form. */
export function wantsStream(request: Request): boolean {
  return (request.headers.get('accept') ?? '')
    .toLowerCase()
    .split(',')
    .some((part) => part.split(';')[0]?.trim() === NDJSON);
}

/** The HTTP status and JSON body a session result stands for, shared by the plain and streamed forms. */
export function describeResult(result: AskResult, now: number): { status: number; body: unknown; pauseUntil?: number } {
  if (result.status === 'budget') {
    const until = nextUtcMidnight(now);
    return { status: 503, body: { state: 'paused', until: new Date(until).toISOString() }, pauseUntil: until };
  }
  if (result.status === 'limit') return { status: 429, body: { state: 'limit', reason: result.reason } };
  // An expired session's storage is deleted (worker/session.ts); its cookie has also expired, so start over.
  if (result.status === 'expired') return { status: 401, body: { error: 'no_session' } };
  // `answered`, `refused` or `unanswered`, shaped and source-checked by worker/reply.ts.
  return { status: 200, body: result };
}

/** What the Worker settles on once the session's run has ended. `result` is null when the run did not report one. */
export type Settle = (result: TimedAskResult | null) => Promise<{ status: number; body: unknown; serverTiming?: string }>;

/**
 * Turns the session object's event stream (status lines, then one `result` line) into the client stream: status
 * lines pass through, pings fill the waits, and the result becomes the `final` line after `settle` has applied it.
 */
export function streamResponse(upstream: ReadableStream<Uint8Array>, settle: Settle, pingMs: number = PING_MS): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let ping: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      let result: TimedAskResult | null = null;
      ping = setInterval(() => {
        try {
          send({ type: 'ping' });
        } catch {
          // The client has gone; `cancel` below stops the work.
        }
      }, pingMs);
      try {
        let buffer = '';
        for (;;) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          const lines = buffer.split('\n');
          buffer = chunk.done ? '' : (lines.pop() ?? '');
          for (const line of lines) {
            if (line.trim() === '') continue;
            const event = JSON.parse(line) as { type?: string; phase?: string; result?: TimedAskResult };
            if (event.type === 'status' && event.phase && PHASES.includes(event.phase)) send({ type: 'status', phase: event.phase });
            if (event.type === 'result' && event.result) result = event.result;
          }
          if (chunk.done) break;
        }
      } catch (error) {
        console.error('agent stream failed', error);
        result = null;
      }
      try {
        const settled = await settle(result);
        send({ type: 'final', ...settled });
      } catch (error) {
        console.error('agent stream could not settle', error);
        send({ type: 'final', status: 502, body: { state: 'error' } });
      } finally {
        clearInterval(ping);
        controller.close();
      }
    },
    cancel(reason) {
      clearInterval(ping);
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    headers: { 'content-type': `${NDJSON}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
