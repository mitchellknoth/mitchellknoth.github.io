import { DurableObject } from 'cloudflare:workers';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness, type LiveState } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from 'agents/lifecycle';
import { corpus } from './corpus';
import { classifyIntent, intentMode, type IntentAi } from './intent';
import { createVisitorAI, modelTimeoutMs, visitorModel } from './model';
import { INSTRUCTIONS, refusal, screenQuestion, shapeReply, type AgentReply } from './reply';
import { createTimer, summarizeRounds, type AskTiming, type PhaseTimer } from './timing';
import { SITE_TOOLS } from './tools';

// One object per visitor session (#13), named by the server. Pi Durable keeps the conversation in this object's
// SQLite storage (its tables start with `pi_`). The agent reads the bundled corpus through two read-only tools
// (worker/tools.ts) and its final text is shaped into the `POST /agent/ask` response by worker/reply.ts.
//
// Retention (#17): the first question starts the session's clock. SESSION_TTL_SECONDS later a Lifecycle job deletes
// the object's whole storage: the conversation, Pi's tables, the job queue and these counters. Questions that arrive
// after expiry are refused without reaching the model. See docs/runbooks/agent-retention.md.

/** `timing` asks `ask` to return its phase timings with the result (the Worker's Server-Timing header). */
export type AskLimits = { maxMessages: number; ttlSeconds: number; timing?: boolean };

export type AskResult =
  | AgentReply
  | { status: 'limit'; reason: 'session_message_limit' }
  | { status: 'budget'; reason: 'inference_budget' }
  | { status: 'expired' };

/** What `ask` returns: the result, plus its phase timings when `limits.timing` is set. */
export type TimedAskResult = AskResult & { timing?: AskTiming };

/** The Lifecycle host job that deletes an expired session. */
export const PURGE_JOB = { id: 'session-ttl', fn: 'purge' } as const;
const PURGE_RETRY_MS = 5_000;

/** True when a model error looks like AI Gateway refusing the call because a spend or rate limit was reached. */
export function isBudgetRefusal(detail: string | undefined): boolean {
  return Boolean(detail && /\b429\b|spend limit|rate limit|too many requests/i.test(detail));
}

const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** The model's reasoning effort from `AGENT_REASONING`. Unset or unknown values mean `off`, so a typo never raises spend. */
export function reasoningLevel(value: string | undefined): ReasoningLevel {
  return REASONING_LEVELS.find((level) => level === value) ?? 'off';
}

export class VisitorSession extends DurableObject<Env> {
  /** How long one model call may stay silent (worker/model.ts); parsed once for the provider and the model. */
  private modelTimeout = modelTimeoutMs(this.env.MODEL_TIMEOUT_MS);

  ai = createVisitorAI(this.env.AI, this.env.AI_GATEWAY_ID, this.modelTimeout);

  registry = createRegistry();

  harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          settings: {
            // One retry at most: a refused or failing model call should not be hammered.
            retry: { maxRetries: 1, baseDelayMs: 500 },
            // Drop inputs queued behind a failed run instead of replaying them later.
            afterFailedRun: 'withdraw',
          },
        },
        context,
      );
    },
    defaults: {
      model: visitorModel(this.ai, this.env.AGENT_MODEL, this.modelTimeout),
      thinkingLevel: reasoningLevel(this.env.AGENT_REASONING),
      // The most model rounds one question may use (each tool round and the final answer are one). Raised from 4
      // to 6 (#16): a long question that searches, reads two pages and searches again was cut off as `turn_limit`
      // in 3 of 8 live runs of one approved question. Start generous and lower it once real visitors' `ask_timing`
      // lines (Workers Logs) show how many rounds answers actually take.
      maxTurns: 6,
    },
  });

  lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.registry.install({
      name: 'site-agent',
      // Pi reserves the `instructions` key for its own section, so the site's rules use their own key.
      sections: [{ key: 'site-rules', render: () => INSTRUCTIONS, tag: false }],
      tools: [...SITE_TOOLS],
    });
  }

  /** Questions being answered right now; the purge waits for them so it never cuts one off. */
  private inFlight = 0;
  /** Set once the purge starts; the object is reset when it ends, so this never needs clearing. */
  private purging = false;

  async ask(question: string, limits: AskLimits): Promise<TimedAskResult> {
    // The purge awaits non-storage work, so a question can arrive while it runs. It must not touch storage.
    if (this.purging) return { status: 'expired' };
    this.inFlight += 1;
    const timer = createTimer();
    try {
      const result = await this.answer(question, limits, timer);
      // Durations and token counts only (worker/timing.ts); a logging failure never fails the question.
      const timing = timer.finish(result, { model: this.env.AGENT_MODEL, effort: reasoningLevel(this.env.AGENT_REASONING) });
      try {
        console.log(JSON.stringify({ event: 'ask_timing', ...timing }));
      } catch {}
      return limits.timing ? { ...result, timing } : result;
    } finally {
      this.inFlight -= 1;
    }
  }

  private async answer(question: string, limits: AskLimits, timer: PhaseTimer): Promise<AskResult> {
    const expired = await timer.time('start', async () => {
      await this.lifecycle.start();
      return this.expired(limits.ttlSeconds);
    });
    if (expired) return { status: 'expired' };

    const asked = this.ctx.storage.sql
      .exec<{ value: number }>(
        `INSERT INTO visitor_meta (key, value) VALUES ('messages', 1)
         ON CONFLICT(key) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .one().value;
    if (asked > limits.maxMessages) return { status: 'limit', reason: 'session_message_limit' };

    const screened = screenQuestion(question);
    if (screened) return refusal(screened);

    const intent = await timer.time('intent', () => this.checkIntent(question));
    if (intent) return intent;

    const result = await timer.time('agent', () => this.harness.prompt(question));
    timer.rounds = this.modelRounds(result.messages);
    if (result.status === 'done') return shapeReply(result.text ?? '', corpus);

    if (result.reason === 'model_error' && isBudgetRefusal(await this.lastFailureDetail())) {
      return { status: 'budget', reason: 'inference_budget' };
    }
    return { status: 'unanswered', reason: result.reason ?? 'unknown' };
  }

  /** The latest question's model rounds, from the transcript the run returned. Never throws: measuring must not break answering. */
  private modelRounds(messages: Parameters<typeof summarizeRounds>[0]) {
    try {
      return summarizeRounds(messages);
    } catch {
      return [];
    }
  }

  /**
   * The intent check (worker/intent.ts): a refusal or a spent budget to return now, or null to carry on to the
   * agent. In `shadow` mode the verdict is logged (never the question) and the question always carries on.
   */
  private async checkIntent(question: string): Promise<AskResult | null> {
    const mode = intentMode(this.env.INTENT_MODE);
    if (mode === 'off') return null;
    const verdict = await classifyIntent(this.env.AI as unknown as IntentAi, question, { gatewayId: this.env.AI_GATEWAY_ID });
    if (verdict.status === 'unavailable') {
      if (isBudgetRefusal(verdict.detail)) return { status: 'budget', reason: 'inference_budget' };
      console.error('intent check unavailable; the question goes to the agent', verdict.detail);
      return null;
    }
    if (verdict.status === 'flagged') {
      console.log(JSON.stringify({ event: 'intent', mode, refusal: verdict.refusal, probability: verdict.probability }));
      if (mode === 'enforce') return refusal(verdict.refusal);
    }
    return null;
  }

  /**
   * Starts the TTL clock on the session's first question and reports whether it has run out. The expiry is fixed
   * from that first question; later questions do not extend it.
   */
  private async expired(ttlSeconds: number): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS visitor_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    const now = Date.now();
    const expiresAt = sql
      .exec<{ value: number }>(
        `INSERT INTO visitor_meta (key, value) VALUES ('expires_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = value
         RETURNING value`,
        now + ttlSeconds * 1000,
      )
      .one().value;
    // Keep a purge job queued for the expiry; pushing the same id again replaces it, so this is idempotent.
    if (this.lifecycle.jobs.get(PURGE_JOB.id)?.time !== expiresAt) {
      await this.lifecycle.jobs.push({ ...PURGE_JOB, time: expiresAt });
    }
    return now >= expiresAt;
  }

  /** Lifecycle host job hook: runs when the alarm finds the purge job due. */
  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (job.fn !== PURGE_JOB.fn) return;
    const expiresAt = this.ctx.storage.sql
      .exec<{ value: number }>("SELECT value FROM visitor_meta WHERE key = 'expires_at'")
      .toArray()[0]?.value;
    if (expiresAt !== undefined && Date.now() < expiresAt) return { rescheduleAt: expiresAt };
    // A question that arrived just before expiry finishes first; resetting the object now would fail it.
    if (this.inFlight > 0) return { rescheduleAt: Date.now() + PURGE_RETRY_MS };
    await this.purge();
  }

  /** Deletes everything this session object stores, then resets the object so nothing stays in memory. */
  private async purge(): Promise<void> {
    this.purging = true;
    try {
      // Clear the alarm, including the Lifecycle's own pre-alarm, and stop anything re-arming it.
      await this.lifecycle.disableAlarms();
      await this.lifecycle.dispose();
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    } finally {
      // Reset even if a step failed: the harness is already closed. If storage survived, `expires_at` is still in
      // the past, so the next question re-queues the purge. The timeout lets this job return first.
      setTimeout(() => this.ctx.abort('session expired', { retryAlarm: false }), 0);
    }
  }

  private async lastFailureDetail(): Promise<string | undefined> {
    const watch = await this.harness.session().watch();
    try {
      const live = (watch.value.docs['pi.live'] ?? {}) as LiveState;
      return live.runFailure?.detail;
    } finally {
      await watch.stop();
    }
  }
}
