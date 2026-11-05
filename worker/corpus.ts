import data from '../generated/corpus.json';

// The agent's corpus (#17), bundled into the Worker at build time. `npm run build` writes generated/corpus.json from
// the pages it has just rendered (scripts/corpus/), and Wrangler inlines that file into the Worker bundle, so the
// agent always ships with exactly the text of the pages it quotes. There is no binding, no runtime write path, and
// no fetch: a corpus change is a code change plus a rebuild.

export interface CorpusDocument {
  id: string;
  kind: string;
  title: string;
  summary: string;
  /** Same-origin path of the page, such as `/work/team-brain/`. */
  url: string;
  /** Repository file the page is built from. */
  source: string;
  dataSources: string[];
  entryIds: string[];
}

export interface CorpusEntry {
  id: string;
  documentId: string;
  kind: string;
  source: string;
  /** Same-origin path of the section, such as `/work/team-brain/#the-problem`. */
  url: string;
  title: string;
  headings: string[];
  text: string;
}

export interface CorpusData {
  schemaVersion: number;
  documents: CorpusDocument[];
  entries: CorpusEntry[];
}

/** What `POST /agent/ask` returns for each cited source. */
export interface CitedSource {
  id: string;
  title: string;
  url: string;
}

export type CorpusItem = ({ kind: 'document' } & CorpusDocument) | ({ kind: 'entry' } & CorpusEntry);

export interface CorpusIndex {
  /** Every document ID, then every entry ID, in corpus order. The only IDs a tool or a citation may use. */
  readonly ids: readonly string[];
  get(id: string): CorpusItem | undefined;
  source(id: string): CitedSource | undefined;
  /** Entries ranked by BM25 over title, headings and text; empty when no query word is in the corpus. */
  search(query: string, limit?: number): CorpusEntry[];
}

// Words too common to say anything about which passage answers a question.
const STOPWORDS = new Set(
  (
    'a about after all also am an and any are as at be been but by can could did do does for from had has have he ' +
    'her his how i if in into is it its me mitch knoth more most my no not of on or our she so some than ' +
    'that the their them then there these they this those to was we were what when where which who why will with ' +
    'would you your'
  ).split(' '),
);

/** Lower-cased word stems: accents folded, punctuation dropped, a plural `s` removed. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

const K1 = 1.2;
const B = 0.75;
// A word in the title or a heading says more about a section than the same word in its body.
const TITLE_WEIGHT = 2;
const HEADING_WEIGHT = 3;

export function createCorpusIndex(corpus: CorpusData): CorpusIndex {
  const items = new Map<string, CorpusItem>();
  for (const doc of corpus.documents) items.set(doc.id, { ...doc, kind: 'document' });
  for (const entry of corpus.entries) items.set(entry.id, { ...entry, kind: 'entry' });
  const ids = Object.freeze([...items.keys()]);

  const termCounts = corpus.entries.map((entry) => {
    const counts = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + weight);
    };
    add(entry.title, TITLE_WEIGHT);
    add(entry.headings.join(' '), HEADING_WEIGHT);
    add(entry.text, 1);
    return counts;
  });
  const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, n) => sum + n, 0));
  const averageLength = lengths.reduce((sum, n) => sum + n, 0) / Math.max(lengths.length, 1);
  const documentFrequency = new Map<string, number>();
  for (const counts of termCounts) {
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const total = corpus.entries.length;
  const idf = (term: string) => {
    const n = documentFrequency.get(term) ?? 0;
    return Math.log(1 + (total - n + 0.5) / (n + 0.5));
  };

  return {
    ids,
    get: (id) => items.get(id),
    source(id) {
      const item = items.get(id);
      if (!item) return undefined;
      const section = item.kind === 'entry' ? item.headings.at(-1) : undefined;
      return { id: item.id, title: section ? `${item.title}: ${section}` : item.title, url: item.url };
    },
    search(query, limit = 5) {
      const terms = [...new Set(tokenize(query))];
      if (terms.length === 0) return [];
      return corpus.entries
        .map((entry, i) => {
          let score = 0;
          for (const term of terms) {
            const tf = termCounts[i]!.get(term) ?? 0;
            if (tf === 0) continue;
            score += (idf(term) * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * lengths[i]!) / averageLength));
          }
          return { entry, score, i };
        })
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, Math.max(0, limit))
        .map((hit) => hit.entry);
    },
  };
}

/** The bundled build-time corpus. */
export const corpus = createCorpusIndex(data as CorpusData);
