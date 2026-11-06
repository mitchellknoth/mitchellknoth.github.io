// INTEGRATION POINT — Turnstile pre-clearance (#13 guardrails, #18).
//
// Not wired yet. The plan: render a Turnstile widget with pre-clearance in the island; solving it sets
// the `cf_clearance` cookie, which passes the WAF Managed Challenge on /agent*. The edge enforces
// it, so the Worker never calls Turnstile's verify endpoint.
//
// To wire it, once Mitch has created the widget in Cloudflare (it needs a site key):
//   1. Load https://challenges.cloudflare.com/turnstile/v0/api.js from this module, on demand, only on
//      the homepage, and only when the visitor first asks a question.
//   2. Add `challenges.cloudflare.com` to THIRD_PARTY_ALLOWLIST in tests/support/egress.mjs, with its
//      reason, and update tests/build/egress.test.mjs, which asserts the allowlist is empty today.
//   3. Render the widget into the element marked `data-turnstile-slot` in AgentChat.tsx and resolve
//      `ensureHumanClearance` when its callback fires.
// Until then the island already handles an edge challenge: a 403 carrying `cf-mitigated: challenge`
// becomes the "unverified" state (src/lib/agent/contract.ts).

export type Clearance = 'cleared' | 'unavailable';

/** Resolves once the visitor holds a clearance cookie, or straight away while Turnstile is not wired. */
export async function ensureHumanClearance(): Promise<Clearance> {
  return 'cleared';
}
