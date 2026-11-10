import { defineTool } from '@earendil-works/pi-durable';
import { obj, oneOf, str } from '@earendil-works/pi-schema';
import { corpus as bundledCorpus, type CorpusEntry, type CorpusIndex } from './corpus';

// The agent's complete tool list (#17): two read-only tools over the bundled corpus. Neither takes a URL, neither
// writes, and both return the same text for the same arguments, so Pi may rerun them after a restart
// (`replay: "safe"`). tests/build/agent-contract.test.mjs fails the build if this list changes.
//
// Each passage is introduced by its citation marker, `[[id]]`, which is how the instructions ask the model to cite.

const MAX_QUERY_CHARS = 200;
const SEARCH_RESULTS = 5;

function marker(id: string): string {
  return `[[${id}]]`;
}

function describeEntry(entry: CorpusEntry): string {
  const section = entry.headings.length ? ` > ${entry.headings.join(' > ')}` : '';
  return [
    `${marker(entry.id)} ${entry.title}${section}`,
    `Page: ${entry.url} (from ${entry.source})`,
    '',
    entry.text,
  ].join('\n');
}

function text(value: string) {
  return { output: [{ type: 'text' as const, text: value }] };
}

export function createCorpusTools(corpus: CorpusIndex) {
  const searchCorpus = defineTool({
    name: 'search_corpus',
    description:
      'Search Mitch Knoth’s published projects, essays and résumé. Returns the best-matching passages, each ' +
      'introduced by the citation marker to use for it, such as [[project/team-brain#the-problem]].',
    // obj() is closed: no property other than these is accepted.
    parameters: obj({
      query: str({
        minLength: 1,
        maxLength: MAX_QUERY_CHARS,
        description: 'Words to look for, such as a project name, a technology or a topic.',
      }),
    }),
    replay: 'safe',
    async execute({ query }) {
      const hits = corpus.search(query, SEARCH_RESULTS);
      if (hits.length === 0) {
        return text(`No passages in the corpus match "${query}". Try other words, or say it is not in the corpus.`);
      }
      return text(hits.map(describeEntry).join('\n\n---\n\n'));
    },
  });

  const readSource = defineTool({
    name: 'read_source',
    description:
      'Read one corpus source in full by its ID: a section ID such as project/team-brain#the-problem, or a whole ' +
      'page ID such as project/team-brain or resume.',
    parameters: obj({
      id: oneOf(corpus.ids as readonly string[], { description: 'A corpus ID returned by search_corpus.' }),
    }),
    replay: 'safe',
    async execute({ id }) {
      const item = corpus.get(id);
      if (!item) throw new Error(`Unknown corpus id: ${String(id).slice(0, 80)}`);
      if (item.kind === 'entry') return text(describeEntry(item));
      const entries = item.entryIds.map((entryId) => corpus.get(entryId)).filter((e) => e?.kind === 'entry');
      const header = `${marker(item.id)} ${item.title}\nPage: ${item.url} (from ${item.source})\n${item.summary}`;
      return text([header, ...entries.map((entry) => describeEntry(entry as CorpusEntry))].join('\n\n---\n\n'));
    },
  });

  return [searchCorpus, readSource] as const;
}

/** The tools the visitor session registers. */
export const SITE_TOOLS = createCorpusTools(bundledCorpus);
