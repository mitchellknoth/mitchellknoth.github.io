// The homepage island follows the Worker's kill switch (src/lib/agent/enabled.ts). With the agent switched off the
// island must ship in its switched-off state, so a visitor never meets the edge's human check for a feature that is
// off; with it on, the island must start by checking the agent. Reads the built page, so run `npm run build` first.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parse as parseJsonc } from 'jsonc-parser';

const override = process.env.PUBLIC_AGENT_ENABLED;
const enabled =
  override === 'true' || override === 'false'
    ? override === 'true'
    : parseJsonc(readFileSync('wrangler.jsonc', 'utf8')).vars?.AGENT_ENABLED === 'true';

const home = readFileSync('dist/index.html', 'utf8');
const islandState = home.match(/data-agent-island[^>]*data-state="([^"]+)"/)?.[1];

test('the built homepage island starts in the state the kill switch implies', () => {
  assert.equal(islandState, enabled ? 'loading' : 'offline', `AGENT_ENABLED is ${enabled}`);
});

test('a switched-off island carries its notice and no human-check or loading text', { skip: enabled }, () => {
  assert.match(home, /The agent is switched off right now/);
  assert.doesNotMatch(home, /Checking whether the agent is available/);
  assert.doesNotMatch(home, /Confirming you(’|&#8217;|&#x2019;)re a person/);
});

test('a switched-on island starts by checking the agent', { skip: !enabled }, () => {
  assert.match(home, /Checking whether the agent is available/);
});

// The switched-on build (npm run build:agent-on) is the one whose island can ask for a human check, so it is the one to inspect.
test('the server-rendered island carries no human-check text or widget script', () => {
  const pages = [home, ...(existsSync('dist-agent-on/index.html') ? [readFileSync('dist-agent-on/index.html', 'utf8')] : [])];
  for (const page of pages) {
    assert.doesNotMatch(page, /Cloudflare needs to confirm/);
    assert.doesNotMatch(page, /challenges\.cloudflare\.com/);
    assert.doesNotMatch(page, /Verify you are human/i);
  }
});
