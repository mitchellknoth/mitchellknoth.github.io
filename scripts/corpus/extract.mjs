// Build-time corpus extractor for the site agent (issue #14, milestone M0 of #13).
//
// The corpus is built only from checked-in content: the project write-ups, the published essays
// and the résumé page. Text is read from the pages Astro has just rendered into `dist/`, so text
// from MDX components and the résumé template is captured as visitors see it, and every page is
// mapped back to the repository file it was built from. Nothing is fetched.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'parse5';

export const CORPUS_SCHEMA_VERSION = 1;

/** Default output path, relative to the repository root. Generated; not committed. */
export const CORPUS_OUTPUT = 'generated/corpus.json';

/**
 * The only places corpus content may come from. Each collection maps a repository file to the
 * page Astro builds from it.
 */
export const CORPUS_COLLECTIONS = [
  { kind: 'project', dir: 'src/content/projects', route: (/** @type {string} */ slug) => `/work/${slug}/` },
  { kind: 'post', dir: 'src/content/posts', route: (/** @type {string} */ slug) => `/writing/${slug}/` },
];

export const CORPUS_PAGES = [
  { kind: 'resume', id: 'resume', source: 'src/pages/resume.astro', dataSources: ['src/data/resume.json'], route: '/resume/' },
];

/** Every repository path a corpus document may cite. */
export function isAllowedSource(/** @type {string} */ source) {
  return (
    CORPUS_COLLECTIONS.some(({ dir }) => path.posix.dirname(source) === dir && /\.mdx?$/.test(source)) ||
    CORPUS_PAGES.some((page) => page.source === source || page.dataSources.includes(source))
  );
}

const SKIP_TAGS = new Set([
  'script', 'style', 'template', 'noscript', 'nav', 'img', 'picture', 'svg', 'video', 'audio',
  'iframe', 'button', 'input', 'select', 'textarea', 'form',
]);
const BLOCK_TAGS = new Set([
  'p', 'div', 'ul', 'ol', 'li', 'section', 'article', 'header', 'footer', 'aside', 'figure',
  'figcaption', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'caption', 'dl',
  'dt', 'dd', 'hr', 'main', 'details', 'summary', 'h1', 'h4', 'h5', 'h6',
]);
const SECTION_HEADINGS = new Set(['h2', 'h3']);

/** @typedef {{ nodeName: string, tagName?: string, value?: string, attrs?: Array<{ name: string, value: string }>, childNodes?: Node[] }} Node */

const attr = (/** @type {Node} */ node, /** @type {string} */ name) => node.attrs?.find((a) => a.name === name)?.value;

function textContent(/** @type {Node} */ node) {
  if (node.nodeName === '#text') return node.value ?? '';
  if (node.tagName && (SKIP_TAGS.has(node.tagName) || isIgnored(node))) return '';
  return (node.childNodes ?? []).map(textContent).join('');
}

function isIgnored(/** @type {Node} */ node) {
  return attr(node, 'data-corpus-ignore') !== undefined || attr(node, 'aria-hidden') === 'true' || attr(node, 'hidden') !== undefined;
}

function findFirst(/** @type {Node} */ node, /** @type {(n: Node) => boolean} */ predicate) {
  /** @type {Node[]} */
  const stack = [node];
  while (stack.length) {
    const current = /** @type {Node} */ (stack.shift());
    if (predicate(current)) return current;
    stack.unshift(...(current.childNodes ?? []));
  }
  return undefined;
}

const clean = (/** @type {string} */ text) => text.replace(/\s+/g, ' ').trim();

export function slugify(/** @type {string} */ text) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Flattens an article into an ordered list of text blocks and section headings.
 * @param {Node} root
 */
function flatten(root) {
  /** @type {Array<{ type: 'text', text: string } | { type: 'heading', level: number, text: string, anchor?: string }>} */
  const blocks = [];
  let title = '';
  let buffer = '';
  let prefix = '';
  const flush = () => {
    const text = clean(buffer);
    if (text) blocks.push({ type: 'text', text: prefix + text });
    buffer = '';
    prefix = '';
  };

  /** @param {Node} node */
  const walk = (node) => {
    if (node.nodeName === '#text') {
      buffer += node.value ?? '';
      return;
    }
    const tag = node.tagName;
    if (!tag) return;
    if (SKIP_TAGS.has(tag) || isIgnored(node)) return;
    if (tag === 'h1') {
      flush();
      title ||= clean(textContent(node));
      return;
    }
    if (SECTION_HEADINGS.has(tag)) {
      flush();
      blocks.push({ type: 'heading', level: Number(tag[1]), text: clean(textContent(node)), anchor: attr(node, 'id') });
      return;
    }
    if (tag === 'br') {
      buffer += '\n';
      return;
    }
    // A container whose children are separate items rendered without separators (tag chips).
    if (attr(node, 'data-corpus-items') !== undefined) {
      flush();
      const items = (node.childNodes ?? []).map((child) => clean(textContent(child))).filter(Boolean);
      buffer = items.join(', ');
      flush();
      return;
    }
    if (tag === 'td' || tag === 'th') {
      if (clean(buffer)) buffer += ' | ';
      (node.childNodes ?? []).forEach(walk);
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    if (tag === 'li') prefix = '- ';
    (node.childNodes ?? []).forEach(walk);
    if (block) flush();
  };

  walk(root);
  flush();
  return { title, blocks };
}

/**
 * Splits a rendered page into entries: an introduction, then one entry per h2/h3 section.
 * @param {string} html
 * @param {{ id: string, kind: string, source: string, dataSources: string[], url: string }} doc
 */
export function extractDocument(html, doc) {
  const tree = /** @type {Node} */ (/** @type {unknown} */ (parse(html)));
  const main = findFirst(tree, (n) => n.tagName === 'main');
  const article = main && findFirst(main, (n) => n.tagName === 'article');
  if (!article) throw new Error(`${doc.source}: no <main> <article> in the built page ${doc.url}`);
  const head = findFirst(tree, (n) => n.tagName === 'head');
  const description = head && findFirst(head, (n) => n.tagName === 'meta' && attr(n, 'name') === 'description');

  const { title, blocks } = flatten(article);
  if (!title) throw new Error(`${doc.source}: the built page ${doc.url} has no <h1>`);

  /** @type {Array<{ anchor?: string, slug: string, headings: string[], text: string[] }>} */
  const sections = [{ slug: 'intro', headings: [], text: [] }];
  /** @type {string[]} */
  let trail = [];
  for (const block of blocks) {
    if (block.type === 'heading') {
      trail = block.level === 2 ? [block.text] : [...trail.slice(0, 1), block.text];
      sections.push({ anchor: block.anchor, slug: block.anchor || slugify(block.text), headings: trail, text: [] });
    } else {
      sections[sections.length - 1].text.push(block.text);
    }
  }

  const seen = new Set();
  const entries = [];
  for (const section of sections) {
    if (section.text.length === 0) continue;
    let slug = section.slug || 'section';
    for (let n = 2; seen.has(slug); n += 1) slug = `${section.slug}-${n}`;
    seen.add(slug);
    const text = section.text.join('\n\n');
    entries.push({
      id: `${doc.id}#${slug}`,
      documentId: doc.id,
      kind: doc.kind,
      source: doc.source,
      url: section.anchor ? `${doc.url}#${section.anchor}` : doc.url,
      title,
      headings: section.headings,
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  }

  return {
    document: {
      id: doc.id,
      kind: doc.kind,
      title,
      summary: description ? clean(attr(description, 'content') ?? '') : '',
      url: doc.url,
      source: doc.source,
      dataSources: doc.dataSources,
      entryIds: entries.map((entry) => entry.id),
    },
    entries,
  };
}

/** Maps a built route to its HTML file in dist. */
const routeFile = (/** @type {string} */ distDir, /** @type {string} */ route) => path.join(distDir, route, 'index.html');

/**
 * Lists every corpus candidate from the repository, in a stable order.
 * @param {string} rootDir
 */
export async function listCorpusSources(rootDir) {
  const docs = [];
  for (const collection of CORPUS_COLLECTIONS) {
    const files = (await readdir(path.join(rootDir, collection.dir))).filter((f) => /\.mdx?$/.test(f)).sort();
    for (const file of files) {
      const slug = file.replace(/\.mdx?$/, '');
      docs.push({
        id: `${collection.kind}/${slug}`,
        kind: collection.kind,
        source: `${collection.dir}/${file}`,
        dataSources: [],
        url: collection.route(slug),
      });
    }
  }
  for (const page of CORPUS_PAGES) {
    docs.push({ id: page.id, kind: page.kind, source: page.source, dataSources: page.dataSources, url: page.route });
  }
  return docs;
}

/**
 * Extracts the corpus from a completed build.
 * @param {{ rootDir: string, distDir: string }} options
 */
export async function extractCorpus({ rootDir, distDir }) {
  const documents = [];
  const entries = [];
  const excluded = [];
  for (const doc of await listCorpusSources(rootDir)) {
    const file = routeFile(distDir, doc.url);
    if (!existsSync(file)) {
      // Drafts are not built, so they never reach the corpus.
      excluded.push({ source: doc.source, reason: `no built page at ${doc.url} (draft or unpublished)` });
      continue;
    }
    const result = extractDocument(await readFile(file, 'utf8'), doc);
    documents.push(result.document);
    entries.push(...result.entries);
  }
  const words = entries.reduce((sum, entry) => sum + entry.text.split(/\s+/).filter(Boolean).length, 0);
  return {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    stats: { documents: documents.length, entries: entries.length, words },
    documents,
    entries,
    excluded,
  };
}

/**
 * Extracts the corpus and writes it as JSON.
 * @param {{ rootDir: string, distDir: string, outFile?: string }} options
 */
export async function writeCorpus({ rootDir, distDir, outFile = path.join(rootDir, CORPUS_OUTPUT) }) {
  const corpus = await extractCorpus({ rootDir, distDir });
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(corpus, null, 2)}\n`);
  return { corpus, outFile };
}
