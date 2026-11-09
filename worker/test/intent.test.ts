import { describe, expect, it } from 'vitest';
import { classifyIntent, INTENT_MODEL, INTENT_THRESHOLD, intentMode, type IntentAi } from '../intent';

// Offline: a stand-in for the AI binding returns canned Clef answers. These tests cover how the Worker reads and
// acts on Clef's probabilities; how well Clef itself separates questions is measured by the eval set, not here.

const OPTIONS = { gatewayId: 'test-gateway' };

function answers(probabilities: Partial<Record<'prompt_injection' | 'social_engineering' | 'personal', number>>) {
  const noul = (value = 0.01) => ({ type: 'noul', noul: value });
  return {
    model: 'clef',
    usage: { input_tokens: 1, output_tokens: 0 },
    answers: {
      prompt_injection: noul(probabilities.prompt_injection),
      social_engineering: noul(probabilities.social_engineering),
      personal: noul(probabilities.personal),
    },
  };
}

function fake(respond: () => Promise<unknown>) {
  const calls: Array<{ model: string; input: Record<string, any>; options?: Record<string, any> }> = [];
  const ai: IntentAi = {
    run: (model, input, options) => {
      calls.push({ model, input, options });
      return respond();
    },
  };
  return { ai, calls };
}

describe('the request to Clef', () => {
  it('sends only the visitor message as state, through the visitor gateway with logging off', async () => {
    const { ai, calls } = fake(async () => answers({}));
    await classifyIntent(ai, 'What is Team Brain?', OPTIONS);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(INTENT_MODEL);
    expect(calls[0].input.model).toBe('clef');
    expect(calls[0].input.state).toEqual({ visitor_message: 'What is Team Brain?' });
    expect(Object.keys(calls[0].input.questions).sort()).toEqual(['personal', 'prompt_injection', 'social_engineering']);
    for (const question of Object.values<any>(calls[0].input.questions)) {
      expect(question.type).toBe('noul');
      expect(question.criteria.true).toBeTruthy();
      expect(question.criteria.false).toBeTruthy();
    }
    expect(calls[0].options?.gateway).toMatchObject({ id: 'test-gateway', collectLog: false });
  });
});

describe('reading the probabilities', () => {
  it('is clear when every question is below the threshold', async () => {
    const { ai } = fake(async () => answers({ personal: INTENT_THRESHOLD - 0.01 }));
    expect(await classifyIntent(ai, 'q', OPTIONS)).toEqual({ status: 'clear' });
  });

  it.each([
    ['prompt_injection', 'prompt-injection'],
    ['social_engineering', 'social-engineering'],
    ['personal', 'personal'],
  ] as const)('flags %s at the threshold as %s', async (id, refusal) => {
    const { ai } = fake(async () => answers({ [id]: INTENT_THRESHOLD }));
    expect(await classifyIntent(ai, 'q', OPTIONS)).toEqual({ status: 'flagged', refusal, probability: INTENT_THRESHOLD });
  });

  it('picks the most likely kind when several are flagged', async () => {
    const { ai } = fake(async () => answers({ personal: 0.85, social_engineering: 0.97 }));
    expect(await classifyIntent(ai, 'q', OPTIONS)).toMatchObject({ status: 'flagged', refusal: 'social-engineering' });
  });

  it('honours a different threshold', async () => {
    const { ai } = fake(async () => answers({ personal: 0.5 }));
    expect(await classifyIntent(ai, 'q', { ...OPTIONS, threshold: 0.4 })).toMatchObject({ status: 'flagged', refusal: 'personal' });
  });
});

describe('when Clef cannot answer', () => {
  it('reports an error as unavailable, with its message', async () => {
    const { ai } = fake(async () => {
      throw new Error('429 spend limit reached');
    });
    expect(await classifyIntent(ai, 'q', OPTIONS)).toEqual({ status: 'unavailable', detail: '429 spend limit reached' });
  });

  it('reports a timeout as unavailable', async () => {
    const { ai } = fake(() => new Promise(() => {}));
    const verdict = await classifyIntent(ai, 'q', { ...OPTIONS, timeoutMs: 20 });
    expect(verdict).toMatchObject({ status: 'unavailable' });
    expect((verdict as { detail: string }).detail).toMatch(/timed out/);
  });

  it.each([
    ['an empty response', undefined],
    ['no answers', {}],
    ['a missing question', { answers: { prompt_injection: { type: 'noul', noul: 0.1 } } }],
    ['a probability outside 0 to 1', { answers: { ...answers({}).answers, personal: { type: 'noul', noul: 7 } } }],
    ['the wrong answer type', { answers: { ...answers({}).answers, personal: { type: 'score', score: 1 } } }],
  ])('treats %s as unavailable, never as clear', async (_name, response) => {
    const { ai } = fake(async () => response);
    expect(await classifyIntent(ai, 'q', OPTIONS)).toMatchObject({ status: 'unavailable' });
  });
});

describe('the mode', () => {
  it('is off unless set to shadow or enforce', () => {
    expect(intentMode('enforce')).toBe('enforce');
    expect(intentMode('shadow')).toBe('shadow');
    for (const value of [undefined, '', 'off', 'true', 'ENFORCE']) expect(intentMode(value)).toBe('off');
  });
});
