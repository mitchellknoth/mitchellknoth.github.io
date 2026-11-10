import { describeResult, streamResponse, wantsStream, type Settled } from './ask-response';
import { GUARD_NAME } from './guard';
import { SESSION_COOKIE } from './session-cookie';
import { serverTimingHeader } from './timing';

export { Guard } from './guard';
export { VisitorSession } from './session';

// Worker entry (#13, M2). Static pages are served from dist/ before this code runs; only /agent/* is routed
// here first (assets.run_worker_first in wrangler.jsonc). Every other request that reaches the Worker is handed
// back to the assets binding, so the site behaves exactly as the assets-only build did.
// Named exports of this module must be Durable Object classes or handlers; the runtime rejects anything else.

const SESSION_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type AgentState = 'offline' | 'paused' | 'blocked' | 'error';

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}

function refused(state: AgentState, status: number, until?: number): Response {
  return json({ state, ...(until ? { until: new Date(until).toISOString() } : {}) }, status);
}

function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** Same-origin only: browsers send Origin on POST, and it must be this site's own origin. */
function isSameOrigin(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin;
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

async function handleAgent(request: Request, env: Env, path: string): Promise<Response> {
  if (env.AGENT_ENABLED !== 'true') return refused('offline', 503);

  const guard = env.GUARD.getByName(GUARD_NAME);

  if (path === '/agent/health' && request.method === 'GET') {
    const status = await guard.status();
    return status.paused ? refused('paused', 200, status.pausedUntil ?? undefined) : json({ state: 'online' });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  if (!isSameOrigin(request)) return json({ error: 'cross_origin' }, 403);

  if (path === '/agent/session') {
    // The server picks the object name; the visitor only ever holds it as an HttpOnly cookie.
    const name = crypto.randomUUID();
    const maxAge = intVar(env.SESSION_TTL_SECONDS, 86_400);
    return json({ state: 'online' }, 201, {
      'set-cookie': `${SESSION_COOKIE}=${name}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
    });
  }

  if (path === '/agent/ask') {
    const name = readCookie(request, SESSION_COOKIE);
    if (!name || !SESSION_NAME.test(name)) return json({ error: 'no_session' }, 401);

    let question: unknown;
    try {
      question = ((await request.json()) as { question?: unknown }).question;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const maxChars = intVar(env.MAX_PROMPT_CHARS, 1_000);
    if (typeof question !== 'string' || question.trim() === '') return json({ error: 'empty_question' }, 400);
    if (question.length > maxChars) return json({ error: 'question_too_long', maxChars }, 413);

    // Phase timing (worker/timing.ts): durations only, never the question, the IP address or the session name.
    const requestStart = Date.now();
    const admission = await guard.admit(clientIp(request), intVar(env.DAILY_AGENT_REQUESTS, 500));
    const admitMs = Date.now() - requestStart;
    if (!admission.allowed) {
      return admission.reason === 'blocked'
        ? refused('blocked', 403, admission.until)
        : refused('paused', 503, admission.until);
    }

    const wantTiming = env.TIMING_HEADER === 'true';
    const session = env.VISITOR_SESSION.getByName(name);
    const limits = {
      maxMessages: intVar(env.MAX_MESSAGES_PER_SESSION, 20),
      ttlSeconds: intVar(env.SESSION_TTL_SECONDS, 86_400),
      timing: wantTiming,
    };
    const sessionStart = Date.now();

    // Everything that turns the question into the plain response's status and body. The plain form returns it as
    // JSON; the streamed form (worker/ask-response.ts) sends it as the `final` line after progress and pings.
    const run = async (): Promise<Settled> => {
      let result: Awaited<ReturnType<typeof session.ask>>;
      try {
        result = await session.ask(question, limits);
      } catch (error) {
        // Log the cause for the operator; the visitor gets a plain state, never a stack trace.
        console.error('agent session failed', error);
        console.log(JSON.stringify({ event: 'agent_request', outcome: 'error', admit: admitMs, session: Date.now() - sessionStart, total: Date.now() - requestStart }));
        return { status: 502, body: { state: 'error' } };
      }
      const sessionMs = Date.now() - sessionStart;
      const { timing, ...body } = result;
      const described = describeResult(body, Date.now());
      if (described.pauseUntil) await guard.pause(described.pauseUntil, 'inference_budget');
      const figures = { admit: admitMs, session: sessionMs, total: Date.now() - requestStart };
      console.log(JSON.stringify({ event: 'agent_request', outcome: body.status, ...figures }));
      return {
        status: described.status,
        body: described.body,
        ...(wantTiming ? { serverTiming: serverTimingHeader(figures, timing) } : {}),
      };
    };

    if (wantsStream(request)) return streamResponse(run);
    const settled = await run();
    const response = json(settled.body, settled.status);
    // Headers cannot follow the first byte of a stream, so the streamed form carries this in its `final` line.
    if (settled.serverTiming) response.headers.set('server-timing', settled.serverTiming);
    return response;
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/agent' || path.startsWith('/agent/')) return handleAgent(request, env, path);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
