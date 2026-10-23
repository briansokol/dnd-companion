import { findWorkspaceRoot, loadConfig } from '@dnd/shared';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVec, ollamaEmbedder } from '../embeddings/embed.js';
import { citation } from './chunks.js';
import { searchRules } from './rules.js';

// Runs the spot-check questions against the local rules.db and live Ollama.

const questions = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'spotcheck-questions.json'), 'utf8')
) as { question: string; expected: string[] }[];

const config = loadConfig();
const db = new Database(resolve(findWorkspaceRoot(process.cwd()), config.RULES_DB_PATH), {
  readonly: true
});
loadVec(db);
const embed = ollamaEmbedder({ baseUrl: config.OLLAMA_BASE_URL, model: config.EMBED_MODEL });

let passed = 0;
let keywordOnly = false;
for (const { question, expected } of questions) {
  const result = await searchRules(db, question, {
    audience: 'player',
    model: config.EMBED_MODEL,
    embed,
    limit: 3
  });
  if (result.mode === 'fts') keywordOnly = true;
  const ok = result.chunks.some((c) => expected.includes(`${c.kind}:${c.slug}`));
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${question}`);
  for (const c of result.chunks) console.log(`        ${citation(c)} (${c.kind}:${c.slug})`);
}
db.close();

console.log(`\n${passed}/${questions.length} passed`);
if (keywordOnly) console.log('Vectors were unusable, so this ran keyword-only.');
if (passed < questions.length || keywordOnly) process.exit(1);
