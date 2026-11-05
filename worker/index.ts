import { GUARD_NAME, nextUtcMidnight } from './guard';
import { SESSION_COOKIE } from './session-cookie';

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
    return json({ state: status.paused ? 'paused' : 'online' });
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

    const admission = await guard.admit(clientIp(request), intVar(env.DAILY_AGENT_REQUESTS, 500));
    if (!admission.allowed) {
      return admission.reason === 'blocked'
        ? refused('blocked', 403, admission.until)
        : refused('paused', 503, admission.until);
    }

    const session = env.VISITOR_SESSION.getByName(name);
    let result: Awaited<ReturnType<typeof session.ask>>;
    try {
      result = await session.ask(question, intVar(env.MAX_MESSAGES_PER_SESSION, 20));
    } catch (error) {
      // Log the cause for the operator; the visitor gets a plain state, never a stack trace.
      console.error('agent session failed', error);
      return refused('error', 502);
    }
    if (result.status === 'budget') {
      const until = nextUtcMidnight(Date.now());
      await guard.pause(until, 'inference_budget');
      return refused('paused', 503, until);
    }
    if (result.status === 'limit') return json({ state: 'limit', reason: result.reason }, 429);
    return json(result);
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
