import { describe, expect, it } from 'vitest';
import { replyToMessage, sourcesOf, textOf, userMessage } from '../../src/lib/agent/messages';

describe('AI SDK message adapter', () => {
  it('wraps the visitor question as a user UIMessage', () => {
    expect(userMessage('u1', 'What is Team Brain?')).toEqual({
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'What is Team Brain?' }],
    });
  });

  it('turns an answer into a text part plus deduplicated source-url parts', () => {
    const message = replyToMessage('a1', {
      status: 'answered',
      text: 'Team Brain is a shared repository.',
      sources: [
        { id: 'project/team-brain#the-problem', title: 'The problem', url: '/work/team-brain/#the-problem' },
        { id: 'project/team-brain#the-problem', title: 'The problem', url: '/work/team-brain/#the-problem' },
        { id: 'resume', title: 'Résumé', url: '/resume/' },
      ],
    });
    expect(message).toEqual({
      id: 'a1',
      role: 'assistant',
      metadata: { status: 'answered' },
      parts: [
        { type: 'text', text: 'Team Brain is a shared repository.' },
        { type: 'source-url', sourceId: 'project/team-brain#the-problem', url: '/work/team-brain/#the-problem', title: 'The problem' },
        { type: 'source-url', sourceId: 'resume', url: '/resume/', title: 'Résumé' },
      ],
    });
    expect(textOf(message)).toBe('Team Brain is a shared repository.');
    expect(sourcesOf(message).map((s) => s.url)).toEqual(['/work/team-brain/#the-problem', '/resume/']);
  });

  it('keeps the refusal kind in metadata and the text as a part', () => {
    expect(replyToMessage('a2', { status: 'refused', refusal: 'not-in-corpus', text: 'Nothing I can cite covers that.' })).toEqual({
      id: 'a2',
      role: 'assistant',
      metadata: { status: 'refused', refusal: 'not-in-corpus' },
      parts: [{ type: 'text', text: 'Nothing I can cite covers that.' }],
    });
  });

  it('gives an unanswered reply no text, so the UI says so in its own words', () => {
    const message = replyToMessage('a3', { status: 'unanswered', reason: 'model_error' });
    expect(message).toEqual({ id: 'a3', role: 'assistant', metadata: { status: 'unanswered' }, parts: [] });
    expect(textOf(message)).toBe('');
  });
});
