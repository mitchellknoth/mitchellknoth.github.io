// Agent-side contract (#13). Each check below fails the build when the Worker drifts from the agreed
// boundary. The tool-list check is still a placeholder until M3 registers the corpus tools; it may not be
// deleted.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
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
  assert.equal(readWranglerConfig().vars.AGENT_ENABLED, 'false');
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

test('the agent exposes exactly the read-only tool list', {
  todo: 'M3: load the registered tools and assert their names equal EXPECTED_TOOLS, so adding a tool fails the build',
});
