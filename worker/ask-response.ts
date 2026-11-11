import { nextUtcMidnight } from './guard';
import type { AskResult } from './session';

// The two shapes of a `POST /agent/ask` answer (#16, option A). The plain one is a single JSON body. A client that
// sends `Accept: application/x-ndjson` gets the same answer as a stream of lines, so it sees where the work is while
// it waits and the connection never sits idle:
//
//   {"type":"status","phase":"checking"}              at once; `searching` and `writing` are reserved
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

/** True when the client asked for the streamed form. */
export function wantsStream(request: Request): boolean {
  return (request.headers.get('accept') ?? '')
    .toLowerCase()
    .split(',')
    .some((part) => {
      const [type, ...params] = part.split(';').map((piece) => piece.trim());
      // `q=0` means "not acceptable".
      return type === NDJSON && !params.some((param) => /^q=0(?:\.0*)?$/.test(param));
    });
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

/** What the Worker settles on once the session's run has ended: the HTTP status and JSON body of the plain response. */
export type Settled = { status: number; body: unknown; serverTiming?: string };

/**
 * The streamed form of an answer. `work` is everything that produces the plain response; while it runs the client
 * gets a `checking` line at once and a `ping` every `pingMs`, then one `final` line with what `work` settled on. A
 * client that disconnects stops the lines but not `work`, so the session, the guard and the logs see the same
 * thing as for a plain request.
 */
export function streamResponse(work: () => Promise<Settled>, pingMs: number = PING_MS): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  let ping: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          cancelled = true;
        }
      };
      send({ type: 'status', phase: 'checking' });
      ping = setInterval(() => send({ type: 'ping' }), pingMs);
      try {
        send({ type: 'final', ...(await work()) });
      } catch (error) {
        console.error('agent stream failed', error instanceof Error ? error.message : String(error));
        send({ type: 'final', status: 502, body: { state: 'error' } });
      } finally {
        clearInterval(ping);
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // Already closed by a cancel that arrived meanwhile.
          }
        }
      }
    },
    cancel() {
      cancelled = true;
      clearInterval(ping);
    },
  });

  return new Response(body, {
    headers: { 'content-type': `${NDJSON}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}
