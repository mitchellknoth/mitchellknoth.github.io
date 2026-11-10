import { createAI } from 'agents/models/pi-ai';

// How long one model call may stay silent (#16). A live measurement on 2026-11-10 found a single call that took
// 125.9 s to write 116 tokens, while every other part of that question was normal. The slowest healthy call in the
// same run took 15 s (43 rounds), so 30 s leaves a 2x margin for a hard question at max effort while still capping a hang. Two guards use the same figure:
//   - the gateway's request timeout (`cf-aig-request-timeout`): the provider must start answering within it;
//   - the stream idle deadline: once answering, no gap between bytes may exceed it.
// A call that trips either fails, and Pi's one retry (worker/session.ts) tries it again.

export const MODEL_TIMEOUT_MS = 30_000;

/** `MODEL_TIMEOUT_MS` from the environment; anything that is not a positive whole number means the default. */
export function modelTimeoutMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MODEL_TIMEOUT_MS;
}

/** The Workers AI provider every visitor model call goes through, with the gateway's request timeout. */
export function createVisitorAI(binding: Ai, gatewayId: string, timeoutMs: number) {
  return createAI({
    binding,
    // Every call goes through this AI Gateway, where the spend limit lives. Gateway logs are off so
    // visitor prompts are not stored outside the session object.
    id: gatewayId,
    collectLog: false,
    requestTimeoutMs: timeoutMs,
    metadata: { surface: 'visitor' },
  });
}

/** The answering model, with the stream idle deadline. */
export function visitorModel(ai: ReturnType<typeof createVisitorAI>, modelId: string, timeoutMs: number) {
  return ai(modelId, { streamIdleTimeoutMs: timeoutMs });
}
