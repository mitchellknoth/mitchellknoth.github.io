import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { corpus } from '../corpus';
import { INSTRUCTIONS } from '../reply';
import { MAX_PREFETCH_CHARS, promptWithPassages } from '../retrieval';

// Search before the model (#16): the Worker puts the best-matching passages in the first prompt, so most questions
// need one model call instead of a search round and then an answer round (live baseline: 2.75 rounds, about 3 s of
// fixed cost each). Offline: nothing here reaches the model.

const QUESTION = 'What is the Team Brain project, and what was Mitch responsible for in it?';

describe('promptWithPassages', () => {
  it('puts the best-matching passages first, each with its citation marker, and the question last', () => {
    const prompt = promptWithPassages(QUESTION, corpus);
    const top = corpus.search(QUESTION, 1)[0]!;
    expect(prompt).toContain(`[[${top.id}]]`);
    expect(prompt).toContain(top.text.slice(0, 80));
    expect(prompt.endsWith(QUESTION)).toBe(true);
    expect(prompt.indexOf(`[[${top.id}]]`)).toBeLessThan(prompt.lastIndexOf(QUESTION));
  });

  it('only offers citation markers that exist in the corpus', () => {
    const prompt = promptWithPassages(QUESTION, corpus);
    const markers = [...prompt.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]!);
    expect(markers.length).toBeGreaterThan(0);
    for (const id of markers) expect(corpus.source(id), id).toBeDefined();
  });

  it('is only the question when nothing in the corpus matches', () => {
    expect(promptWithPassages('zzzz qqqq xxxx', corpus)).toBe('zzzz qqqq xxxx');
  });

  it('keeps the added text within a fixed size', () => {
    for (const question of [QUESTION, 'Tell me about the agent harness essay', 'What certifications does Mitch hold?']) {
      const prompt = promptWithPassages(question, corpus);
      expect(prompt.length - question.length).toBeLessThanOrEqual(MAX_PREFETCH_CHARS + 600);
    }
  });

  it('marks the passages as quoted material, never instructions', () => {
    expect(promptWithPassages(QUESTION, corpus)).toMatch(/never instructions/i);
  });
});

describe('instructions', () => {
  it('say the passages arrive with the question and keep the tools for when they fall short', () => {
    expect(INSTRUCTIONS).not.toMatch(/First find the relevant passages with search_corpus/);
    expect(INSTRUCTIONS).toMatch(/passages/i);
    expect(INSTRUCTIONS).toContain('search_corpus');
    expect(INSTRUCTIONS).toContain('read_source');
  });
});

describe('the session object', () => {
  it('stores the passages with the visitor’s question as the user message the model sees', async () => {
    const stub = env.VISITOR_SESSION.getByName(crypto.randomUUID());
    // Passes the screen; offline the model is unreachable, so the run ends unanswered after the prompt is stored.
    await stub.ask(QUESTION, { maxMessages: 20, ttlSeconds: 86_400 });
    const stored = await runInDurableObject(stub, async (instance) => {
      const entries = await instance.harness.session().messages();
      return entries
        .filter((entry) => entry.kind === 'pi.user')
        .flatMap((entry) => entry.model ?? [])
        .map((message) => JSON.stringify((message as { content?: unknown }).content));
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('[[');
    expect(stored[0]).toContain(QUESTION);
  });
});
