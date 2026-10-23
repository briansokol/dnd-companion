import { findWorkspaceRoot, loadConfig } from '@dnd/shared';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { embedChunks, loadVec, ollamaEmbedder, tableExists } from './embed.js';

const config = loadConfig();
const dbPath = resolve(findWorkspaceRoot(process.cwd()), config.RULES_DB_PATH);
const model = config.EMBED_MODEL;

try {
  if (!existsSync(dbPath)) throw new Error(`${dbPath} does not exist; run pnpm data:import first`);
  const db = new Database(dbPath);
  try {
    if (!tableExists(db, 'rules_chunks')) {
      throw new Error(`${dbPath} has no rules_chunks; run pnpm data:import first`);
    }
    loadVec(db);
    console.log(`Embedding rules chunks in ${dbPath} with ${model} at ${config.OLLAMA_BASE_URL}`);
    const result = await embedChunks(db, {
      model,
      embed: ollamaEmbedder({ baseUrl: config.OLLAMA_BASE_URL, model }),
      onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`)
    });
    if (result.embedded > 0) process.stdout.write('\n');
    console.log(`Embedded ${result.embedded} of ${result.total} chunks with ${model}`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
