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

const HEALTH_TIMEOUT_MS = 8_000;
// Answers wait on the model and its tool calls; streaming (a later change) will replace this wait. At max
// reasoning effort the live check saw 11 to 26 s, and a minute or more under load, so this leaves headroom
// past the slow end instead of abandoning an answer that is still coming.
export const ASK_TIMEOUT_MS = 120_000;

async function receive(path: string, init: RequestInit, timeoutMs: number): Promise<Received> {
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
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
  interpretAsk(await receive('/agent/ask', { method: 'POST', body: JSON.stringify({ question }) }, ASK_TIMEOUT_MS));

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
