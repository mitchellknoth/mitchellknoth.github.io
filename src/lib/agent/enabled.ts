import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

/**
 * Whether the homepage island should talk to the agent at all. Build-time and server-side only: it is
 * called from the page's frontmatter, never from the island.
 *
 * The Worker's kill switch is `vars.AGENT_ENABLED` in wrangler.jsonc, and the page is built from the same
 * commit that deploys it, so the page reads the switch from that file. Turning the agent on is then one
 * change in one place, and the island can't be left asking a Worker that is switched off.
 *
 * With the agent off, every /agent/* request answers `503 offline` from the Worker, but on the live site the
 * edge's Managed Challenge on /agent/* answers first, so a visitor would meet a "verify you are human" box
 * for a feature that is off. When the agent is off, the island therefore makes no request and no check, and
 * shows its switched-off notice from the first paint.
 *
 * `PUBLIC_AGENT_ENABLED` ("true" or "false") overrides the file. The Playwright dev server sets it so the
 * island's live states can be exercised against mocked responses.
 */
export function agentEnabled(): boolean {
  const override = import.meta.env.PUBLIC_AGENT_ENABLED;
  if (override === 'true' || override === 'false') return override === 'true';
  // Builds and the dev server run from the repository root (npm scripts and CI).
  const file = path.resolve(process.cwd(), 'wrangler.jsonc');
  const config = parseJsonc(readFileSync(file, 'utf8')) as { vars?: { AGENT_ENABLED?: string } };
  return config.vars?.AGENT_ENABLED === 'true';
}
