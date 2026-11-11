// The streamed form of `POST /agent/ask` (#16, option A). The island asks for it with
// `Accept: application/x-ndjson`; the Worker then answers with one JSON object per line:
//
//   {"type":"status","phase":"checking" | "searching" | "writing"}   what the agent is doing now
//   {"type":"ping"}                                                  every few seconds while it works
//   {"type":"final","status":200,"body":{...}}                       the HTTP status and body the plain JSON
//                                                                    response would have had
//
// Status events say where the work is, never what the answer says: answers are checked after the run, so no answer
// text is shown before it has been checked. A stream that ends without a `final` event, or that goes quiet for
// longer than the idle limit, is a failed request. Anything not described here is skipped.
import type { Received } from './contract';

export type AskPhase = 'checking' | 'searching' | 'writing';
const PHASES: readonly AskPhase[] = ['checking', 'searching', 'writing'];

export type AskStreamEvent =
  | { type: 'status'; phase: AskPhase }
  | { type: 'ping' }
  | { type: 'final'; status: number; body: unknown };

/** The longest silence tolerated, pings included. The Worker pings every 10 seconds. */
export const STREAM_IDLE_MS = 30_000;

export function parseStreamLine(line: string): AskStreamEvent | null {
  if (line.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.type === 'ping') return { type: 'ping' };
  if (event.type === 'status' && typeof event.phase === 'string' && (PHASES as readonly string[]).includes(event.phase)) {
    return { type: 'status', phase: event.phase as AskPhase };
  }
  if (event.type === 'final' && typeof event.status === 'number' && Number.isInteger(event.status)) {
    return { type: 'final', status: event.status, body: event.body };
  }
  return null;
}

/**
 * Reads the stream to its `final` event and returns it as the response it stands for, so the same interpreter
 * (`interpretAsk`) decides what it means. `null` when the stream fails, ends early or goes quiet.
 */
export async function readAskStream(
  body: ReadableStream<Uint8Array>,
  options: { onPhase?: (phase: AskPhase) => void; idleMs?: number },
): Promise<Received> {
  const idleMs = options.idleMs ?? STREAM_IDLE_MS;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quiet = new Promise<'quiet'>((resolve) => {
        timer = setTimeout(() => resolve('quiet'), idleMs);
      });
      const chunk = await Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
      if (chunk === 'quiet') return null;
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const parts = buffer.split('\n');
      buffer = chunk.done ? '' : (parts.pop() ?? '');
      if (chunk.done && parts.at(-1) === '') parts.pop();
      for (const part of parts) {
        const event = parseStreamLine(part);
        if (event?.type === 'status') options.onPhase?.(event.phase);
        if (event?.type === 'final') return { status: event.status, body: event.body, headers: new Headers() };
      }
      if (chunk.done) return null;
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
}
