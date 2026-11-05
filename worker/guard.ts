import { DurableObject } from 'cloudflare:workers';

// The single `guard` object (#13, M2) that every /agent/* request asks first. It holds the global state a
// per-visitor session object cannot: a blocklist with expiry, daily counters, and a "paused until" flag set
// when the inference budget runs out. Static pages never reach it; they are served before the Worker runs.

export const GUARD_NAME = 'global';

export type Admission =
  | { allowed: true }
  | { allowed: false; reason: 'blocked'; until: number }
  | { allowed: false; reason: 'paused'; until: number };

export type GuardStatus = {
  paused: boolean;
  pausedUntil: number | null;
  pauseReason: string | null;
  blockedCount: number;
  today: Record<string, number>;
};

/** Start of the next UTC day, in epoch milliseconds. Daily caps and budget pauses reset then. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class Guard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS blocklist (
          ip TEXT PRIMARY KEY,
          until INTEGER NOT NULL,
          reason TEXT NOT NULL,
          created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS counters (
          day TEXT NOT NULL,
          name TEXT NOT NULL,
          value INTEGER NOT NULL,
          PRIMARY KEY (day, name)
        );
        CREATE TABLE IF NOT EXISTS pause (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          until INTEGER NOT NULL,
          reason TEXT NOT NULL
        );
      `);
    });
  }

  /**
   * Decide whether a request may reach the model. Counts admitted requests per UTC day and pauses the
   * agent until the next UTC midnight once `dailyLimit` is reached.
   */
  async admit(ip: string, dailyLimit: number, now = Date.now()): Promise<Admission> {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM blocklist WHERE until <= ?', now);
    sql.exec('DELETE FROM pause WHERE until <= ?', now);
    sql.exec('DELETE FROM counters WHERE day < ?', utcDay(now - 7 * 24 * 60 * 60 * 1000));

    const blocked = sql.exec<{ until: number }>('SELECT until FROM blocklist WHERE ip = ?', ip).toArray()[0];
    if (blocked) {
      this.increment('blocked', now);
      return { allowed: false, reason: 'blocked', until: blocked.until };
    }

    const pause = sql.exec<{ until: number }>('SELECT until FROM pause WHERE id = 1').toArray()[0];
    if (pause) return { allowed: false, reason: 'paused', until: pause.until };

    const admitted = this.increment('admitted', now);
    if (admitted > dailyLimit) {
      const until = nextUtcMidnight(now);
      this.pause(until, 'daily_request_limit', now);
      return { allowed: false, reason: 'paused', until };
    }
    return { allowed: true };
  }

  /** Block one address from the agent until `now + ttlMs`. Static pages stay readable. */
  async block(ip: string, ttlMs: number, reason: string, now = Date.now()): Promise<number> {
    const until = now + ttlMs;
    this.ctx.storage.sql.exec(
      `INSERT INTO blocklist (ip, until, reason, created) VALUES (?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET until = MAX(until, excluded.until), reason = excluded.reason`,
      ip,
      until,
      reason,
      now,
    );
    return until;
  }

  /** Pause the agent for everyone until `until`, e.g. when the AI Gateway spend limit answers 429. */
  async pause(until: number, reason: string, now = Date.now()): Promise<void> {
    if (until <= now) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO pause (id, until, reason) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET until = MAX(until, excluded.until), reason = excluded.reason`,
      until,
      reason,
    );
  }

  async status(now = Date.now()): Promise<GuardStatus> {
    const sql = this.ctx.storage.sql;
    const pause = sql
      .exec<{ until: number; reason: string }>('SELECT until, reason FROM pause WHERE id = 1 AND until > ?', now)
      .toArray()[0];
    const blockedCount = sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM blocklist WHERE until > ?', now)
      .one().count;
    const today = Object.fromEntries(
      sql
        .exec<{ name: string; value: number }>('SELECT name, value FROM counters WHERE day = ?', utcDay(now))
        .toArray()
        .map((row) => [row.name, row.value]),
    );
    return {
      paused: Boolean(pause),
      pausedUntil: pause?.until ?? null,
      pauseReason: pause?.reason ?? null,
      blockedCount,
      today,
    };
  }

  private increment(name: string, now: number): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>(
        `INSERT INTO counters (day, name, value) VALUES (?, ?, 1)
         ON CONFLICT(day, name) DO UPDATE SET value = value + 1
         RETURNING value`,
        utcDay(now),
        name,
      )
      .one().value;
  }
}
