// Agent-side contract (#13). M0 has no Worker or agent code, so these are placeholders that report
// as TODO. The milestone named in each one replaces it with a real assertion; none may be deleted.
import test from 'node:test';

/** The only binding types the Worker may declare. Binding names are chosen in M2. */
export const EXPECTED_BINDING_TYPES = Object.freeze(['ai', 'assets', 'durable_objects']);

/** The agent's complete tool list. Both tools are read-only and take no URL. */
export const EXPECTED_TOOLS = Object.freeze(['read_source', 'search_corpus']);

test('the Worker declares only the Durable Object, AI and ASSETS bindings', {
  todo: 'M2: parse the Wrangler config and assert its binding types equal EXPECTED_BINDING_TYPES (no KV, R2, D1, service, or other bindings)',
});

test('agent code makes no public fetch() or connect() calls', {
  todo: 'M2: scan the Worker and agent sources for fetch(), connect() and WebSocket clients; only binding calls (Durable Objects, AI through AI Gateway, ASSETS) are allowed',
});

test('the agent exposes exactly the read-only tool list', {
  todo: 'M3: load the registered tools and assert their names equal EXPECTED_TOOLS, so adding a tool fails the build',
});
