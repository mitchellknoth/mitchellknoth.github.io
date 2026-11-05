import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { nextUtcMidnight } from '../guard';

const NOW = Date.UTC(2026, 10, 5, 15, 0, 0);
const HOUR = 60 * 60 * 1000;

function guard(name = crypto.randomUUID()) {
  return env.GUARD.getByName(name);
}

describe('guard', () => {
  it('admits an unknown address and counts it', async () => {
    const g = guard();
    expect(await g.admit('203.0.113.1', 10, NOW)).toEqual({ allowed: true });
    expect((await g.status(NOW)).today).toEqual({ admitted: 1 });
  });

  it('refuses a blocked address until its entry expires', async () => {
    const g = guard();
    const until = await g.block('203.0.113.2', HOUR, 'prompt_injection', NOW);
    expect(await g.admit('203.0.113.2', 10, NOW + 1)).toEqual({ allowed: false, reason: 'blocked', until });
    expect(await g.admit('203.0.113.3', 10, NOW + 1)).toEqual({ allowed: true });
    expect(await g.admit('203.0.113.2', 10, NOW + HOUR)).toEqual({ allowed: true });
  });

  it('keeps the later expiry when an address is blocked twice', async () => {
    const g = guard();
    const later = await g.block('203.0.113.4', 2 * HOUR, 'first', NOW);
    await g.block('203.0.113.4', HOUR, 'second', NOW);
    expect(await g.admit('203.0.113.4', 10, NOW + 1)).toMatchObject({ reason: 'blocked', until: later });
  });

  it('pauses everyone until the next UTC midnight once the daily limit is passed', async () => {
    const g = guard();
    expect(await g.admit('203.0.113.5', 2, NOW)).toEqual({ allowed: true });
    expect(await g.admit('203.0.113.6', 2, NOW)).toEqual({ allowed: true });
    const midnight = nextUtcMidnight(NOW);
    expect(await g.admit('203.0.113.7', 2, NOW)).toEqual({ allowed: false, reason: 'paused', until: midnight });
    expect(await g.admit('203.0.113.8', 2, NOW + 1)).toEqual({ allowed: false, reason: 'paused', until: midnight });
    expect(await g.status(NOW + 1)).toMatchObject({ paused: true, pausedUntil: midnight, pauseReason: 'daily_request_limit' });
    expect(await g.admit('203.0.113.8', 2, midnight)).toEqual({ allowed: true });
  });

  it('honours an explicit pause, such as an inference budget refusal', async () => {
    const g = guard();
    await g.pause(NOW + HOUR, 'inference_budget', NOW);
    expect(await g.admit('203.0.113.9', 10, NOW + 1)).toEqual({ allowed: false, reason: 'paused', until: NOW + HOUR });
    expect(await g.admit('203.0.113.9', 10, NOW + HOUR)).toEqual({ allowed: true });
  });

  it('computes the next UTC midnight across month ends', () => {
    expect(nextUtcMidnight(Date.UTC(2026, 10, 30, 23, 59))).toBe(Date.UTC(2026, 11, 1));
  });
});
