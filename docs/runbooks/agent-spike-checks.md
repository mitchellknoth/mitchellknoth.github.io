# Agent spike: deploy-time checks

Milestone M2 of [#13](https://github.com/mitchellknoth/mitchellknoth.github.io/issues/13), tracked in
[#16](https://github.com/mitchellknoth/mitchellknoth.github.io/issues/16). The repo side is tested offline
(`npm run test:worker`, `tests/build/agent-contract.test.mjs`). This runbook covers what can only be shown on a
real deployment. Record each result, with dates and versions, on #16.

Run these on workers.dev before the agent is linked from the site. The agent ships switched off
(`AGENT_ENABLED = "false"` in `wrangler.jsonc`), so deploying this branch changes nothing for visitors.

## Pinned versions

| Package | Version |
|---|---|
| `agents` | 0.33.0 |
| `@earendil-works/pi-durable`, `pi-ai`, `pi-schema`, `chord` | 1.5.0 |
| `wrangler` | 4.158.0 |
| `compatibility_date` | 2026-11-05 |
| Answering model (`AGENT_MODEL`) | `openai/gpt-6-luna` (through the AI binding and the gateway; the eval scorecard can change it) |
| Reasoning effort (`AGENT_REASONING`) | `max` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; unknown values mean `off`). If Cloudflare rejects `max` for the model, drop to `high` and record the error. |

Pi Durable is experimental. A conversation written by a newer Pi minor version can't be read after rolling
back, so fix a bad deploy by rolling forward.

## 1. AI Gateway and the spend limit

1. **AI → AI Gateway → Create gateway**, id `mitchellknoth-com-agent` (the `AI_GATEWAY_ID` var).
2. Set **Workers AI billing** to **Unified billing** and load a small amount of credit.
3. Add a **spend limit** rule with no dimensions (one shared budget) and a deliberately tiny amount for the test.
4. Turn gateway logging off, or confirm `collectLog: false` keeps prompts out of the logs.

Check: with the agent enabled on workers.dev, ask questions until the limit is reached. Expected:
- `/agent/ask` returns `503 {"state":"paused"}`
- `/agent/health` reports `paused`
- the pause lifts at the next UTC midnight

If the gateway's 429 doesn't come back as a `model_error` matching `isBudgetRefusal()` in `worker/session.ts`,
record the actual error text and adjust that function.

## 2. Turnstile pre-clearance and the WAF rule

1. **Turnstile → Add widget** for `mitchellknoth.com`, with **pre-clearance** on (Free plan supports it).
2. **Security → WAF → Custom rules**: if the URI path starts with `/agent`, take the action **Managed Challenge**.
3. **Security → WAF → Rate limiting rules**: if the URI path starts with `/agent`, allow N requests per IP per
   10 seconds (Free plan: one rule, 10-second period).

Check, on the custom domain (WAF rules don't apply to workers.dev):
- a request to `/agent/health` without `cf_clearance` gets a challenge, not JSON
- after passing the challenge or the pre-clearance widget in a browser, `fetch('/agent/health')` from that page
  returns JSON
- the Worker logs no call to `challenges.cloudflare.com`

The widget itself ships with the chat UI in M4; this step only proves the edge rules and the cookie work together.

## 3. Guard and kill switch

- With `AGENT_ENABLED = "false"`: every `/agent/*` route returns `503 {"state":"offline"}`, and every page still
  passes the parity contract (`WORKERS_BASE_URL=… npx playwright test workers-parity --project desktop`).
- With the agent on: `POST /agent/session` from the site's origin returns `201` and sets
  `__Host-agent_session` (HttpOnly, Secure, SameSite=Strict). A cross-origin POST returns `403`.
- Pi answers on Workers AI: `POST /agent/ask` returns `{"status":"answered", …}` and says it can't answer from
  Mitch's work yet. No tools are registered in M2.

## 4. Turn it back off

Set `AGENT_ENABLED` back to `"false"` (or leave it off in `wrangler.jsonc` and redeploy), remove the test spend
limit or raise it to the real budget, and record the results on #16.

## Known gaps carried into M3

- Session retention: Pi Durable can't delete a conversation yet. M3 purges whole session objects through a
  Lifecycle job, 24 hours after the first question ([agent-retention.md](agent-retention.md)).
- The guard stores raw IPs only for blocked addresses, each with an expiry. It keeps no per-IP history.
- Responses are not streamed yet; M4 adds the watch-based stream for the chat island.
