import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { corpus } from '../corpus';
import { SITE_TOOLS } from '../tools';

type AnyTool = (typeof SITE_TOOLS)[number];

function tool(name: string): AnyTool {
  const found = SITE_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/** Runs a tool the way the harness would after validation; these tools use neither the API nor the context. */
async function run(name: string, args: unknown): Promise<string> {
  const result = await tool(name).execute(args as never, {} as never, {} as never);
  const output = result.output ?? [];
  return output.map((item) => (item.type === 'text' ? item.text : '')).join('');
}

/** Every property name anywhere in a JSON Schema. */
function propertyNames(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const own = node.properties && typeof node.properties === 'object' ? Object.keys(node.properties) : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
}

describe('tool list', () => {
  it('is exactly search_corpus and read_source', () => {
    expect(SITE_TOOLS.map((t) => t.name).sort()).toEqual(['read_source', 'search_corpus']);
  });

  it('marks both tools safe to replay', () => {
    for (const t of SITE_TOOLS) expect(t.replay, t.name).toBe('safe');
  });

  it('takes no URL, link or path argument', () => {
    for (const t of SITE_TOOLS) {
      for (const name of propertyNames(t.parameters)) expect(name, t.name).not.toMatch(/url|uri|href|link|path/i);
    }
  });

  it('is what the session object registers', async () => {
    const stub = env.VISITOR_SESSION.getByName(crypto.randomUUID());
    const names = await runInDurableObject(stub, (session) =>
      session.registry
        .snapshot()
        .tools()
        .map(({ tool: t }) => t.name)
        .sort(),
    );
    expect(names).toEqual(['read_source', 'search_corpus']);
  });
});

describe('search_corpus', () => {
  const schema = tool('search_corpus').parameters as Record<string, any>;

  it('takes one bounded query string', () => {
    expect(schema.required).toEqual(['query']);
    expect(Object.keys(schema.properties)).toEqual(['query']);
    expect(schema.properties.query).toMatchObject({ type: 'string', minLength: 1 });
    expect(schema.properties.query.maxLength).toBeLessThanOrEqual(300);
    expect(schema.additionalProperties).toBe(false);
  });

  it('returns passages with their corpus ID, title, same-origin URL and source file', async () => {
    const text = await run('search_corpus', { query: 'team brain' });
    const top = corpus.search('team brain')[0]!;
    expect(text).toContain(`[[${top.id}]]`);
    expect(text).toContain(top.url);
    expect(text).toContain(top.source);
    expect(text).toContain(top.title);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('says so when nothing matches, instead of returning an empty result', async () => {
    const text = await run('search_corpus', { query: 'zzzz qqqq' });
    expect(text).toMatch(/no passages/i);
  });
});

describe('read_source', () => {
  const schema = tool('read_source').parameters as Record<string, any>;

  it('accepts only build-time corpus IDs', () => {
    expect(schema.required).toEqual(['id']);
    expect(schema.properties.id.enum).toEqual(corpus.ids);
    expect(schema.additionalProperties).toBe(false);
  });

  it('returns an entry with its citation marker and text', async () => {
    const entry = corpus.search('team brain')[0]!;
    const text = await run('read_source', { id: entry.id });
    expect(text).toContain(`[[${entry.id}]]`);
    expect(text).toContain(entry.text.slice(0, 80));
  });

  it('returns every entry of a document, each with its own citation marker', async () => {
    const text = await run('read_source', { id: 'resume' });
    const doc = corpus.get('resume');
    expect(doc?.kind).toBe('document');
    for (const entryId of doc?.kind === 'document' ? doc.entryIds : []) expect(text).toContain(`[[${entryId}]]`);
  });

  it('fails an unknown ID even if validation were bypassed', async () => {
    await expect(run('read_source', { id: 'https://example.com/' })).rejects.toThrow(/unknown corpus id/i);
  });
});
