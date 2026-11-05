// Astro integration: writes the agent corpus after every `astro build`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_OUTPUT, writeCorpus } from './extract.mjs';

/** @returns {import('astro').AstroIntegration} */
export default function agentCorpus() {
  let rootDir = process.cwd();
  return {
    name: 'agent-corpus',
    hooks: {
      'astro:config:done': ({ config }) => {
        rootDir = fileURLToPath(config.root);
      },
      'astro:build:done': async ({ dir, logger }) => {
        const { corpus } = await writeCorpus({ rootDir, distDir: fileURLToPath(dir) });
        const { documents, entries, words } = corpus.stats;
        logger.info(`${documents} documents, ${entries} entries, ${words} words -> ${path.posix.normalize(CORPUS_OUTPUT)}`);
      },
    },
  };
}
