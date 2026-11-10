// Browser calls to the agent's same-origin endpoints. Every call resolves (never throws) to the
// outcome types in ./contract, so the island has one place that decides what each response means.
import {
  interpretAsk,
  interpretHealth,
  interpretSession,
  type AskOutcome,
  type HealthState,
  type Received,
  type SessionOutcome,
} from './contract';
import { readAskStream } from './stream';

const HEALTH_TIMEOUT_MS = 8_000;
// An answer waits on the model and its tool calls. The Worker streams progress and a ping every 10 seconds while
// it works (src/lib/agent/stream.ts), so a stream that goes quiet for 30 seconds is abandoned sooner than this;
// this is the outer bound for the whole answer, and for a host that answers only with plain JSON.
export const ASK_TIMEOUT_MS = 120_000;

const STREAM_ACCEPT = 'application/x-ndjson, application/json;q=0.9';

async function receive(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  options: { stream?: boolean } = {},
): Promise<Received> {
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: options.stream ? STREAM_ACCEPT : 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The streamed form (a 200 from the Worker); every other answer, and a host that ignores the Accept header,
    // is the plain JSON below.
    if (options.stream && response.status === 200 && response.body && (response.headers.get('content-type') ?? '').includes('application/x-ndjson')) {
      return await readAskStream(response.body, {});
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON (a static 404 page, an edge challenge): the interpreters handle a string body.
    }
    return { status: response.status, body, headers: response.headers };
  } catch {
    return null;
  }
}

export async function checkHealth(): Promise<HealthState> {
  return interpretHealth(await receive('/agent/health', { method: 'GET' }, HEALTH_TIMEOUT_MS));
}

export async function startSession(): Promise<SessionOutcome> {
  return interpretSession(await receive('/agent/session', { method: 'POST' }, HEALTH_TIMEOUT_MS));
}

const post = async (question: string) =>
  interpretAsk(await receive('/agent/ask', { method: 'POST', body: JSON.stringify({ question }) }, ASK_TIMEOUT_MS, { stream: true }));

/**
 * Asks one question. Sessions are created lazily: a visitor who never asks never gets a cookie.
 * When the session cookie is missing or has expired, start a new session and ask once more.
 */
export async function askQuestion(question: string): Promise<AskOutcome> {
  const first = await post(question);
  if (first.type !== 'no-session') return first;
  const session = await startSession();
  if (session.type === 'state') return session;
  if (session.type === 'throttled') return session;
  if (session.type === 'error') return { type: 'error' };
  const second = await post(question);
  return second.type === 'no-session' ? { type: 'error' } : second;
}
