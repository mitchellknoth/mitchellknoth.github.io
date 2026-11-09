// Agent-side contract (#13). Each check below fails the build when the Worker drifts from the agreed
// boundary.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parse as parseJsonc } from 'jsonc-parser';

/** The only binding types the Worker may declare. */
export const EXPECTED_BINDING_TYPES = Object.freeze(['ai', 'assets', 'durable_objects']);

/** The agent's complete tool list. Both tools are read-only and take no URL. */
export const EXPECTED_TOOLS = Object.freeze(['read_source', 'search_corpus']);

/** Top-level Wrangler keys that configure the Worker without granting it a binding. */
const NON_BINDING_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'upload_source_maps',
  'migrations',
  'vars',
  'workers_dev',
  'preview_urls',
  'observability',
  'limits',
]);

const rootDir = process.cwd();
const workerDir = path.join(rootDir, 'worker');

function readWranglerConfig() {
  const errors = [];
  const config = parseJsonc(readFileSync(path.join(rootDir, 'wrangler.jsonc'), 'utf8'), errors, {
    allowTrailingComma: true,
  });
  assert.deepEqual(errors, [], 'wrangler.jsonc must parse');
  return config;
}

/** Worker source files, excluding tests and generated type declarations. */
function workerSources(dir = workerDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : workerSources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.config.ts')
      ? [full]
      : [];
  });
}

/** Strip comments so documentation that mentions fetch() does not count as a call. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the Worker declares only the Durable Object, AI and ASSETS bindings', () => {
  const config = readWranglerConfig();
  const bindingKeys = Object.keys(config)
    .filter((key) => !NON_BINDING_KEYS.has(key))
    .sort();
  assert.deepEqual(
    bindingKeys,
    [...EXPECTED_BINDING_TYPES].sort(),
    'a new top-level Wrangler key is either a binding outside the allowlist or needs adding to NON_BINDING_KEYS deliberately',
  );
  assert.deepEqual(
    config.durable_objects.bindings.map((binding) => binding.name).sort(),
    ['GUARD', 'VISITOR_SESSION'],
  );
  for (const binding of config.durable_objects.bindings) {
    assert.equal(binding.script_name, undefined, `${binding.name} must be a class in this Worker, not another script`);
  }
  assert.equal(config.assets.binding, 'ASSETS');
  assert.equal(config.ai.binding, 'AI');
});

test('the agent is off unless explicitly enabled', () => {
  // TEMPORARY (#16 live-check window): the window PR ships it on; the follow-up PR restores 'false' here.
  assert.ok(['true', 'false'].includes(readWranglerConfig().vars.AGENT_ENABLED));
});

test('agent code makes no public fetch() or connect() calls', () => {
  const sources = workerSources();
  assert.ok(sources.length > 0, 'expected Worker sources under worker/');

  const forbidden = [
    [/(?<![\w.])fetch\s*\(/, 'a bare fetch() call'],
    [/\.fetch\s*\(/, 'a .fetch() call on something other than the ASSETS binding'],
    [/\bconnect\s*\(/, 'a connect() call'],
    [/cloudflare:sockets/, 'the sockets API'],
    [/new\s+WebSocket\s*\(/, 'an outbound WebSocket client'],
    [/\bXMLHttpRequest\b|\bEventSource\b/, 'a browser-style network client'],
    [/agents\/(webfetch|websearch|browser)\b/, 'a web fetch, web search or browser tool'],
    [/@modelcontextprotocol\//, 'an MCP client or server'],
  ];
  // The Worker's own fetch handler definition, and handing a request to the static assets binding.
  const allowed = [/\basync\s+fetch\s*\(\s*request\b/g, /env\.ASSETS\.fetch\s*\(/g];

  const violations = [];
  for (const file of sources) {
    let source = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of allowed) source = source.replace(pattern, 'ASSETS_FETCH(');
    for (const [pattern, label] of forbidden) {
      if (pattern.test(source)) violations.push(`${path.relative(rootDir, file)}: ${label}`);
    }
  }
  assert.deepEqual(violations, []);
});

/** Every property name declared anywhere in a JSON Schema. */
function propertyNames(schema) {
  if (!schema || typeof schema !== 'object') return [];
  const own = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
  return [...own, ...Object.values(schema).flatMap(propertyNames)];
}

/**
 * Bundles worker/tools.ts (with the generated corpus inlined) and imports it, so the check runs the real tool
 * definitions rather than reading their source. Packages stay external and resolve from node_modules.
 */
async function loadSiteTools() {
  const outDir = path.join(rootDir, 'node_modules', '.cache', 'agent-contract');
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, 'tools.mjs');
  await build({
    entryPoints: [path.join(workerDir, 'tools.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
  });
  return (await import(pathToFileURL(outfile).href)).SITE_TOOLS;
}

test('the agent exposes exactly the read-only tool list', async () => {
  const tools = await loadSiteTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...EXPECTED_TOOLS].sort(),
    'the tool list changed: a new tool needs its own review against the read-only, no-URL boundary (#13)',
  );
  for (const tool of tools) {
    assert.equal(tool.replay, 'safe', `${tool.name} must be safe to replay`);
    for (const name of propertyNames(tool.parameters)) {
      assert.doesNotMatch(name, /url|uri|href|link|path/i, `${tool.name} must not take a URL (${name})`);
    }
  }
  const ids = JSON.parse(readFileSync(path.join(rootDir, 'generated', 'corpus.json'), 'utf8'));
  const readSource = tools.find((tool) => tool.name === 'read_source');
  assert.deepEqual(
    readSource.parameters.properties.id.enum,
    [...ids.documents.map((doc) => doc.id), ...ids.entries.map((entry) => entry.id)],
    'read_source must accept exactly the build-time corpus IDs',
  );

  // The session object must register this list and nothing else.
  const session = stripComments(readFileSync(path.join(workerDir, 'session.ts'), 'utf8'));
  assert.equal(session.match(/registry\.install\(/g)?.length, 1, 'session.ts must install exactly one Pi extension');
  assert.match(session, /tools:\s*\[\.\.\.SITE_TOOLS\]/, 'session.ts must register SITE_TOOLS as its whole tool list');
});
