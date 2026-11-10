import { createModels } from '@earendil-works/pi-ai/models';
import { describe, expect, it } from 'vitest';
import { createVisitorAI, MODEL_TIMEOUT_MS, modelTimeoutMs, visitorModel } from '../model';

// One model call must not be able to hang for minutes (#16: a single call took 125.9 s for 116 output tokens, with
// the rest of that question normal). Offline: the AI binding is a stand-in that never sends a byte.

describe('modelTimeoutMs', () => {
  it('reads MODEL_TIMEOUT_MS as whole milliseconds and falls back to the default', () => {
    expect(modelTimeoutMs('15000')).toBe(15_000);
    expect(modelTimeoutMs(undefined)).toBe(MODEL_TIMEOUT_MS);
    expect(modelTimeoutMs('')).toBe(MODEL_TIMEOUT_MS);
    expect(modelTimeoutMs('soon')).toBe(MODEL_TIMEOUT_MS);
    expect(modelTimeoutMs('0')).toBe(MODEL_TIMEOUT_MS);
    expect(modelTimeoutMs('-5')).toBe(MODEL_TIMEOUT_MS);
  });

  it('defaults to 20 seconds: above the slowest healthy round measured (15 s), far below a hung call', () => {
    expect(MODEL_TIMEOUT_MS).toBe(20_000);
  });
});

describe('a model call that stalls', () => {
  it('asks the gateway for a request timeout and fails a stream that goes silent', async () => {
    const seen: Array<{ model: string; gateway: { requestTimeoutMs?: number; id?: string } | undefined }> = [];
    const binding = {
      // The model goes through the binding's `run`. It returns a raw response whose stream never produces a byte, like a provider that has gone quiet.
      run: async (model: string, _input: unknown, options?: { gateway?: { requestTimeoutMs?: number; id?: string } }) => {
        seen.push({ model, gateway: options?.gateway });
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
      fetch: async () => {
        throw new Error('fetch() is not used for a Workers AI model id');
      },
    } as unknown as Ai;

    const ai = createVisitorAI(binding, 'test-gateway', 150);
    const models = createModels();
    models.setProvider(ai.provider);
    const stream = models.streamSimple(visitorModel(ai, 'openai/gpt-6-luna', 150), {
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
    });

    const started = Date.now();
    const result = await stream.result();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toMatch(/no data received/i);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.gateway).toMatchObject({ id: 'test-gateway', requestTimeoutMs: 150 });
  });
});
