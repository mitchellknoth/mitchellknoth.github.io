// EVAL_MODEL=@cf/<vendor>/<model> CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npm run evals:serve
//
// Starts the agent on this machine for an eval run (#17). The Worker and its Durable Objects run locally, so the
// visitor Guard is never touched. Only the AI binding is remote: Workers AI has no local simulator, so Wrangler
// reaches it through a remote proxy session, and every model call goes through the eval AI Gateway with its own
// spend limit instead of the visitor gateway. Run `npm run build` first: the Worker serves dist/.
//
// The server uses a generated Wrangler config (generated/wrangler.evals.json) derived from wrangler.jsonc,
// so wrangler.jsonc itself never changes. See evals/README.md.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVAL_CONFIG = 'generated/wrangler.evals.json';

/** @typedef {Record<string, any>} WranglerConfig */

/** Wrangler uses a global API key (with its email) before CLOUDFLARE_API_TOKEN, so none of these may be set. */
const GLOBAL_KEY_VARS = ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_KEY', 'CF_EMAIL'];

/**
 * The remote AI binding authenticates with whatever Wrangler finds, and this machine's `wrangler login` reaches
 * unrelated accounts. An explicit scoped token and account are required. With CLOUDFLARE_API_TOKEN set, Wrangler
 * never reads or refreshes a stored OAuth login; a global API key would still win, so it is refused.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ model: string, accountId: string }}
 */
export function requireEvalEnv(env) {
  const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`Refusing to start: set ${missing.join(' and ')} to the scoped eval token and this site's account (see evals/README.md). The local wrangler login is never used.`);
  }
  const globalKey = GLOBAL_KEY_VARS.filter((name) => env[name] !== undefined);
  if (globalKey.length) {
    throw new Error(`Refusing to start: unset ${globalKey.join(', ')}. Wrangler would use a global API key instead of the scoped eval token.`);
  }
  const model = env.EVAL_MODEL?.trim();
  if (!model) throw new Error('Set EVAL_MODEL to the model under test, e.g. EVAL_MODEL=@cf/<vendor>/<model> npm run evals:serve');
  return { model, accountId: /** @type {string} */ (env.CLOUDFLARE_ACCOUNT_ID).trim() };
}

/** @param {string} rootDir @returns {WranglerConfig} */
export function readWranglerConfig(rootDir) {
  /** @type {import('jsonc-parser').ParseError[]} */
  const errors = [];
  const config = parseJsonc(readFileSync(path.join(rootDir, 'wrangler.jsonc'), 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('wrangler.jsonc does not parse');
  return config;
}

/**
 * The eval server's Wrangler config: the production config with
 * - its own Worker name, so the remote proxy session's preview upload never uses the production script name;
 * - the account from CLOUDFLARE_ACCOUNT_ID (a config `account_id` would otherwise take precedence);
 * - the AI binding explicitly remote (Durable Objects and assets have no remote mode, so they stay local);
 * - the kill switch on, the eval AI Gateway and the model under test.
 * Paths are rewritten relative to the generated file, because Wrangler resolves them from the config's folder.
 * @param {WranglerConfig} production
 * @param {{ model: string, accountId: string, configDir: string, rootDir: string, aiGateway?: string }} options
 * @returns {WranglerConfig}
 */
export function evalWranglerConfig(production, { model, accountId, configDir, rootDir, aiGateway }) {
  const gateway = aiGateway ?? JSON.parse(readFileSync(path.join(rootDir, 'evals/config.json'), 'utf8')).aiGateway;
  const relative = (/** @type {string} */ p) => path.relative(configDir, path.resolve(rootDir, p)).split(path.sep).join('/');
  const { $schema: _schema, ...rest } = production;
  return {
    ...rest,
    name: `${production.name}-evals`,
    account_id: accountId,
    main: relative(production.main),
    assets: { ...production.assets, directory: relative(production.assets.directory) },
    ai: { ...production.ai, remote: true },
    vars: { ...production.vars, AGENT_ENABLED: 'true', AI_GATEWAY_ID: gateway, AGENT_MODEL: model },
  };
}

/**
 * `wrangler dev` arguments. Not `--local`: it disables every remote binding, AI included, so the model would never
 * answer. Not `--remote`: that would run the Worker and its Durable Objects on Cloudflare.
 * @param {{ configPath: string, port: string }} options
 * @returns {string[]}
 */
export function serveArgs({ configPath, port }) {
  return ['dev', '--config', configPath, '--ip', '127.0.0.1', '--port', port, '--show-interactive-dev-session=false'];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { model, accountId } = requireEvalEnv(process.env);
    const configPath = path.join(ROOT_DIR, EVAL_CONFIG);
    mkdirSync(path.dirname(configPath), { recursive: true });
    const evalConfig = evalWranglerConfig(readWranglerConfig(ROOT_DIR), { model, accountId, configDir: path.dirname(configPath), rootDir: ROOT_DIR });
    writeFileSync(configPath, `${JSON.stringify(evalConfig, null, 2)}\n`);
    // wrangler's package exports don't include its bin, so run the pinned copy from node_modules directly.
    const wrangler = path.join(ROOT_DIR, 'node_modules/wrangler/bin/wrangler.js');
    const args = serveArgs({ configPath, port: process.env.EVAL_PORT?.trim() || '8787' });
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
