// Re-extracts the agent corpus from an existing build: `npm run build` first.
import path from 'node:path';
import { writeCorpus } from './extract.mjs';

const rootDir = process.cwd();
const { corpus, outFile } = await writeCorpus({ rootDir, distDir: path.join(rootDir, 'dist') });
console.log(`${corpus.stats.documents} documents, ${corpus.stats.entries} entries -> ${path.relative(rootDir, outFile)}`);
