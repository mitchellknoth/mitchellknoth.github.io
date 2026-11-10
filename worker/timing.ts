// Phase timing for one visitor question (#16): where the wall time goes.
//
// Content-free by construction. Everything here is a duration, a token count or a fixed label: no question, no
// answer, no tool arguments, no IP address and no session name ever enter these types. Per-round figures are read
// from the model messages Pi already stores (`durationMs`, `usage`), counting tool calls but never reading their
// arguments. The Worker logs one line per question from this data, and sends it as a `Server-Timing` header only
// when the `TIMING_HEADER` variable is "true" (measurement windows; off in shipping config).
//
// workerd's clock only advances when a call waits on I/O, so only phases that await something are timed here
// (session start, the intent check, the agent run). CPU-only steps such as the deterministic screen and the reply
// shaping would always read 0; their cost is microseconds (measured locally on 2026-11-10, see #16).

/** One model request inside a run. `ms` is the provider call; `gapMs` is the time since the previous round ended. */
export type RoundTiming = {
  ms?: number;
  input: number;
  output: number;
  /** Reasoning tokens, a subset of `output`, when the provider reports them. */
  reasoning?: number;
  cacheRead: number;
  stop: string;
  toolCalls: number;
  gapMs?: number;
};

export type AskTiming = {
  outcome: string;
  /** The refusal category or the reason a run ended without an answer. */
  reason?: string;
  totalMs: number;
  /** Named phases of the session object, in milliseconds. */
  phases: Record<string, number>;
  /** Agent run time not spent inside a model request: queueing, waking, tool execution, commits. */
  agentOverheadMs?: number;
  model: string;
  effort: string;
  rounds: RoundTiming[];
};

/** Any ask result; only its status and reason are read. */
type TimedResult = { status: string; reason?: string; refusal?: string; [field: string]: unknown };

export type PhaseTimer = {
  time<T>(name: string, run: () => Promise<T>): Promise<T>;
  /** Model rounds of the run, set once the agent has finished. */
  rounds: RoundTiming[];
  finish(result: TimedResult, meta: { model: string; effort: string }): AskTiming;
};

export function createTimer(now: () => number = Date.now): PhaseTimer {
  const startedAt = now();
  const phases: Record<string, number> = {};
  const record = (name: string, from: number) => {
    phases[name] = now() - from;
  };
  const timer: PhaseTimer = {
    rounds: [],
    async time(name, run) {
      const from = now();
      try {
        return await run();
      } finally {
        record(name, from);
      }
    },
    finish(result, meta) {
      const timing: AskTiming = {
        outcome: result.status,
        totalMs: now() - startedAt,
        phases: { ...phases },
        model: meta.model,
        effort: meta.effort,
        rounds: timer.rounds,
      };
      const reason = result.reason ?? result.refusal;
      if (reason) timing.reason = reason;
      const modelMs = timer.rounds.reduce((sum, round) => sum + (round.ms ?? 0), 0);
      if (phases.agent !== undefined && modelMs > 0) timing.agentOverheadMs = Math.max(0, phases.agent - modelMs);
      return timing;
    },
  };
  return timer;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

type AssistantFacts = {
  timestamp?: number;
  durationMs?: number;
  stopReason?: unknown;
  usage?: { input?: unknown; output?: unknown; reasoning?: unknown; cacheRead?: unknown };
  content?: unknown;
};

/**
 * The model rounds of the latest question, from Pi's transcript entries (oldest first). Only the fields named in
 * `RoundTiming` are read, so no message text or tool argument can reach a log line.
 */
export function summarizeRounds(entries: ReadonlyArray<{ kind?: string; model?: readonly unknown[] }>): RoundTiming[] {
  let from = 0;
  entries.forEach((entry, index) => {
    if (entry.kind === 'pi.user') from = index + 1;
  });

  const rounds: RoundTiming[] = [];
  let previousEnd: number | undefined;
  for (const entry of entries.slice(from)) {
    if (entry.kind !== 'pi.assistant') continue;
    for (const raw of entry.model ?? []) {
      if (!raw || typeof raw !== 'object' || (raw as { role?: unknown }).role !== 'assistant') continue;
      const message = raw as AssistantFacts;
      const usage = message.usage ?? {};
      const round: RoundTiming = {
        input: num(usage.input),
        output: num(usage.output),
        cacheRead: num(usage.cacheRead),
        stop: typeof message.stopReason === 'string' ? message.stopReason : 'unknown',
        toolCalls: Array.isArray(message.content)
          ? message.content.filter((part) => (part as { type?: unknown } | null)?.type === 'toolCall').length
          : 0,
      };
      if (typeof message.durationMs === 'number') round.ms = Math.round(message.durationMs);
      if (typeof usage.reasoning === 'number') round.reasoning = usage.reasoning;
      if (previousEnd !== undefined && typeof message.timestamp === 'number') {
        round.gapMs = Math.max(0, Math.round(message.timestamp - previousEnd));
      }
      previousEnd =
        typeof message.timestamp === 'number' && typeof message.durationMs === 'number'
          ? message.timestamp + message.durationMs
          : undefined;
      rounds.push(round);
    }
  }
  return rounds;
}

/** The Worker's own measurements for one `POST /agent/ask`. */
export type WorkerTiming = { admit: number; session: number; total: number };

/** A `Server-Timing` header value: Worker phases first, then the session's phases and each model round. */
export function serverTimingHeader(worker: WorkerTiming, timing?: AskTiming): string {
  const metric = (name: string, ms: number | undefined, desc?: string) =>
    `${name}${ms === undefined ? '' : `;dur=${Math.round(ms * 10) / 10}`}${desc ? `;desc="${desc}"` : ''}`;
  const parts = [metric('admit', worker.admit), metric('session', worker.session), metric('total', worker.total)];
  if (timing) {
    for (const [name, ms] of Object.entries(timing.phases)) parts.push(metric(name, ms));
    if (timing.agentOverheadMs !== undefined) parts.push(metric('agent_other', timing.agentOverheadMs));
    timing.rounds.forEach((round, index) => {
      const desc = [
        `in=${round.input}`,
        `out=${round.output}`,
        ...(round.reasoning === undefined ? [] : [`reasoning=${round.reasoning}`]),
        `tools=${round.toolCalls}`,
      ].join(' ');
      parts.push(metric(`round${index + 1}`, round.ms, desc));
    });
  }
  return parts.join(', ');
}
