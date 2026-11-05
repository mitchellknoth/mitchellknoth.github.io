// EVAL_MODEL=@cf/<vendor>/<model> npm run evals:serve
//
// Starts the agent locally for an eval run (#17). Durable Objects run locally, so the visitor Guard is never
// touched, and every model call goes through the eval AI Gateway with its own spend limit instead of the
// visitor gateway that wrangler.jsonc names. Run `npm run build` first: the Worker serves dist/.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(readFileSync(path.join(rootDir, 'evals/config.json'), 'utf8'));

/**
 * The `wrangler` arguments for an eval server. The gateway and the kill switch are fixed here so the safe
 * configuration is the only one this script can start.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function serveArgs(env) {
  const model = env.EVAL_MODEL?.trim();
  if (!model) throw new Error('Set EVAL_MODEL to the model under test, e.g. EVAL_MODEL=@cf/<vendor>/<model> npm run evals:serve');
  return [
    'dev',
    '--local',
    '--ip', '127.0.0.1',
    '--port', env.EVAL_PORT?.trim() || '8787',
    '--show-interactive-dev-session=false',
    '--var', 'AGENT_ENABLED:true',
    '--var', `AI_GATEWAY_ID:${config.aiGateway}`,
    '--var', `AGENT_MODEL:${model}`,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // wrangler's package exports don't include its bin, so run the pinned copy from node_modules directly.
    const wrangler = path.join(rootDir, 'node_modules/wrangler/bin/wrangler.js');
    const child = spawn(process.execPath, [wrangler, ...serveArgs(process.env)], { cwd: rootDir, stdio: 'inherit' });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
