import { describe, expect, it } from 'vitest';
import { corpus, createCorpusIndex, type CorpusData } from '../corpus';

// A tiny corpus with the generated file's shape, so ranking can be checked against known text.
const FIXTURE: CorpusData = {
  schemaVersion: 1,
  documents: [
    {
      id: 'project/gateway',
      kind: 'project',
      title: 'Global Gateway',
      summary: 'An API gateway.',
      url: '/work/gateway/',
      source: 'src/content/projects/gateway.md',
      dataSources: [],
      entryIds: ['project/gateway#intro', 'project/gateway#results'],
    },
    {
      id: 'post/harness',
      kind: 'post',
      title: 'The harness',
      summary: 'Where the harness lives.',
      url: '/writing/harness/',
      source: 'src/content/posts/harness.mdx',
      dataSources: [],
      entryIds: ['post/harness#intro'],
    },
  ],
  entries: [
    {
      id: 'project/gateway#intro',
      documentId: 'project/gateway',
      kind: 'project',
      source: 'src/content/projects/gateway.md',
      url: '/work/gateway/',
      title: 'Global Gateway',
      headings: [],
      text: 'A shared API gateway that routes traffic for many teams.',
    },
    {
      id: 'project/gateway#results',
      documentId: 'project/gateway',
      kind: 'project',
      source: 'src/content/projects/gateway.md',
      url: '/work/gateway/#results',
      title: 'Global Gateway',
      headings: ['Results'],
      text: 'Latency dropped and onboarding took days instead of weeks.',
    },
    {
      id: 'post/harness#intro',
      documentId: 'post/harness',
      kind: 'post',
      source: 'src/content/posts/harness.mdx',
      url: '/writing/harness/',
      title: 'The harness',
      headings: [],
      text: 'The agent harness should not live on your laptop.',
    },
  ],
};

describe('corpus index', () => {
  const index = createCorpusIndex(FIXTURE);

  it('lists every document and entry ID, documents first', () => {
    expect(index.ids).toEqual([
      'project/gateway',
      'post/harness',
      'project/gateway#intro',
      'project/gateway#results',
      'post/harness#intro',
    ]);
  });

  it('ranks the passage that matches the query first', () => {
    const hits = index.search('how did onboarding latency change?');
    expect(hits[0]?.id).toBe('project/gateway#results');
  });

  it('matches title and heading words, not only body text', () => {
    expect(index.search('harness')[0]?.id).toBe('post/harness#intro');
    expect(index.search('results')[0]?.id).toBe('project/gateway#results');
  });

  it('ignores case, punctuation and simple plurals', () => {
    expect(index.search('GATEWAYS!!')[0]?.documentId).toBe('project/gateway');
  });

  it('returns nothing for a query with no corpus words', () => {
    expect(index.search('quantum basket weaving')).toEqual([]);
    expect(index.search('the and of')).toEqual([]);
    expect(index.search('   ')).toEqual([]);
  });

  it('caps the number of passages', () => {
    expect(index.search('gateway', 1)).toHaveLength(1);
  });

  it('resolves document and entry IDs and nothing else', () => {
    expect(index.get('project/gateway#results')).toMatchObject({ kind: 'entry', id: 'project/gateway#results' });
    expect(index.get('project/gateway')).toMatchObject({ kind: 'document', id: 'project/gateway' });
    expect(index.get('project/gateway#missing')).toBeUndefined();
    expect(index.get('https://example.com/')).toBeUndefined();
    expect(index.get('__proto__')).toBeUndefined();
    expect(index.get('toString')).toBeUndefined();
  });

  it('describes a source with its title, section and same-origin URL', () => {
    expect(index.source('project/gateway#results')).toEqual({
      id: 'project/gateway#results',
      title: 'Global Gateway: Results',
      url: '/work/gateway/#results',
    });
    expect(index.source('project/gateway')).toEqual({
      id: 'project/gateway',
      title: 'Global Gateway',
      url: '/work/gateway/',
    });
    expect(index.source('nope')).toBeUndefined();
  });
});

describe('bundled corpus', () => {
  it('is the build-time corpus, bundled into the Worker', () => {
    expect(corpus.ids.length).toBeGreaterThan(50);
    expect(corpus.ids).toContain('resume');
    expect(new Set(corpus.ids).size).toBe(corpus.ids.length);
  });

  it('only ever points at same-origin paths', () => {
    for (const id of corpus.ids) {
      const url = corpus.source(id)?.url ?? '';
      expect(url, id).toMatch(/^\/[^/]/);
      expect(new URL(url, 'https://mitchellknoth.com').origin).toBe('https://mitchellknoth.com');
    }
  });

  it('finds real work by its subject', () => {
    expect(corpus.search('team brain')[0]?.documentId).toBe('project/team-brain');
  });
});
