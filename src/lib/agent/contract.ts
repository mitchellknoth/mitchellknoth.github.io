// Client side of the agent HTTP contract (#13, epic-13 plan note). worker/index.ts implements the
// server side. These functions are pure: they take a status, a parsed body and the headers, and
// decide what the island should do. Anything the contract does not describe is an error or, for
// the health check, `absent`: the site never depends on the agent.

export type Refusal = 'not-in-corpus' | 'personal' | 'social-engineering' | 'prompt-injection';
const REFUSALS: readonly Refusal[] = ['not-in-corpus', 'personal', 'social-engineering', 'prompt-injection'];

export interface Source {
  id: string;
  title: string;
  /** Same-origin path, e.g. `/work/team-brain/#the-problem`. */
  url: string;
}

export type AskReply =
  | { status: 'answered'; text: string; sources: Source[] }
  | { status: 'refused'; refusal: Refusal; text: string }
  | { status: 'unanswered'; reason: string };

/** Island states other than "online" that stop the conversation. `until` is an ISO timestamp. */
export type StoppedState =
  | { kind: 'offline' }
  | { kind: 'paused'; until?: string }
  | { kind: 'blocked'; until?: string }
  | { kind: 'limit' }
  /** Cloudflare's edge challenged the request: the visitor has not cleared Turnstile. */
  | { kind: 'unverified' };

/**
 * `absent` means the host has no agent at all (a static host's 404, a network failure, anything outside
 * the contract): the island removes itself rather than claim an agent exists and is switched off.
 */
export type HealthState = { kind: 'online' } | { kind: 'paused' } | { kind: 'offline' } | { kind: 'unverified' } | { kind: 'absent' };

export type AskOutcome =
  | { type: 'reply'; body: AskReply }
  | { type: 'state'; state: StoppedState }
  | { type: 'too-long'; maxChars?: number }
  | { type: 'no-session' }
  | { type: 'error' };

export type SessionOutcome = { type: 'ok' } | { type: 'state'; state: StoppedState } | { type: 'error' };

/** A response as the island sees it; `null` when the request itself failed. */
export type Received = { status: number; body: unknown; headers: Headers } | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Only site-relative paths: a citation never links off the site or runs script. One leading slash,
 * then no slash or backslash, and no whitespace or control characters anywhere: browsers drop tabs
 * and newlines from URLs, so `/<TAB>/evil.example` would otherwise become `//evil.example`.
 */
const isSitePath = (url: string) => /^\/(?![\/\\])[^\s\u0000-\u001f\u007f\\]*$/.test(url);

function isoOrUndefined(value: unknown): string | undefined {
  return isString(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

const challenged = (received: NonNullable<Received>) => received.headers.get('cf-mitigated') === 'challenge';

function parseSources(value: unknown): Source[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (source): source is Source =>
      isRecord(source) && isString(source.id) && isString(source.title) && isString(source.url) && isSitePath(source.url),
  ).map(({ id, title, url }) => ({ id, title, url }));
}

function parseReply(body: unknown): AskReply | null {
  if (!isRecord(body)) return null;
  if (body.status === 'answered' && isString(body.text)) {
    const sources = parseSources(body.sources);
    return sources ? { status: 'answered', text: body.text, sources } : null;
  }
  if (body.status === 'refused' && isString(body.text) && REFUSALS.includes(body.refusal as Refusal)) {
    return { status: 'refused', refusal: body.refusal as Refusal, text: body.text };
  }
  if (body.status === 'unanswered' && isString(body.reason)) return { status: 'unanswered', reason: body.reason };
  return null;
}

/** The refusal states shared by every POST route; `null` when the response is not one of them. */
function stoppedState(received: NonNullable<Received>): StoppedState | null {
  const { status, body } = received;
  if (status === 403 && challenged(received)) return { kind: 'unverified' };
  if (!isRecord(body)) return null;
  const until = isoOrUndefined(body.until);
  if (status === 503 && body.state === 'offline') return { kind: 'offline' };
  if (status === 503 && body.state === 'paused') return until ? { kind: 'paused', until } : { kind: 'paused' };
  if (status === 403 && body.state === 'blocked') return until ? { kind: 'blocked', until } : { kind: 'blocked' };
  if (status === 429 && body.state === 'limit') return { kind: 'limit' };
  return null;
}

export function interpretHealth(received: Received): HealthState {
  if (!received) return { kind: 'absent' };
  if (received.status === 403 && challenged(received)) return { kind: 'unverified' };
  if (!isRecord(received.body)) return { kind: 'absent' };
  if (received.status === 200 && received.body.state === 'online') return { kind: 'online' };
  if (received.status === 200 && received.body.state === 'paused') return { kind: 'paused' };
  if (received.status === 503 && received.body.state === 'offline') return { kind: 'offline' };
  return { kind: 'absent' };
}

export function interpretSession(received: Received): SessionOutcome {
  if (!received) return { type: 'error' };
  if (received.status === 201) return { type: 'ok' };
  const state = stoppedState(received);
  return state ? { type: 'state', state } : { type: 'error' };
}

export function interpretAsk(received: Received): AskOutcome {
  if (!received) return { type: 'error' };
  const { status, body } = received;
  if (status === 200) {
    const reply = parseReply(body);
    return reply ? { type: 'reply', body: reply } : { type: 'error' };
  }
  const state = stoppedState(received);
  if (state) return { type: 'state', state };
  if (status === 401 && isRecord(body) && body.error === 'no_session') return { type: 'no-session' };
  if (status === 413 && isRecord(body) && body.error === 'question_too_long') {
    return typeof body.maxChars === 'number' ? { type: 'too-long', maxChars: body.maxChars } : { type: 'too-long' };
  }
  return { type: 'error' };
}
