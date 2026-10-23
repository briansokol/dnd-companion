import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { citation } from '../search/chunks.js';

/** Turns texts into vectors, one per text, in order. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** An embedder backed by Ollama's native `/api/embed`. */
export function ollamaEmbedder(options: {
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
}): Embedder {
  const { baseUrl, model } = options;
  const fetchImpl = options.fetch ?? fetch;
  return async (texts) => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts })
      });
    } catch {
      throw new Error(`Ollama is not reachable at ${baseUrl}`);
    }
    if (response.status === 404) {
      throw new Error(`Embedding model "${model}" is not pulled. Run: ollama pull ${model}`);
    }
    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
    }
    return ((await response.json()) as { embeddings: number[][] }).embeddings;
  };
}

/** Task prefixes some embedding models are trained with, keyed by model name without its tag. */
const PREFIXES: Record<string, { document: string; query: string }> = {
  'nomic-embed-text': { document: 'search_document: ', query: 'search_query: ' }
};

export function documentPrefix(model: string): string {
  return PREFIXES[model.split(':')[0]!]?.document ?? '';
}

export function queryPrefix(model: string): string {
  return PREFIXES[model.split(':')[0]!]?.query ?? '';
}

/** Loads the sqlite-vec extension, which rules_vec needs. */
export function loadVec(db: Database.Database): void {
  sqliteVec.load(db);
}

export interface EmbedOptions {
  model: string;
  embed: Embedder;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

interface ChunkRow {
  id: number;
  chapter: string;
  section: string;
  heading: string;
  text: string;
  audience: string;
}

/**
 * Embeds chunks missing from rules_vec, committing each batch so an interrupted run resumes.
 * Rebuilds rules_vec when import_meta.embed_model differs from `model`. The caller loads sqlite-vec.
 */
export async function embedChunks(
  db: Database.Database,
  options: EmbedOptions
): Promise<{ embedded: number; total: number }> {
  const { model, embed, batchSize = 32 } = options;
  db.exec('CREATE TABLE IF NOT EXISTS import_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const getMeta = db.prepare('SELECT value FROM import_meta WHERE key = ?');
  const setMeta = db.prepare(
    'INSERT INTO import_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  const storedModel = (getMeta.get('embed_model') as { value: string } | undefined)?.value;
  if (storedModel !== model) {
    db.exec('DROP TABLE IF EXISTS rules_vec');
    db.exec("DELETE FROM import_meta WHERE key IN ('embed_model', 'embed_dims')");
  }
  let hasTable = tableExists(db, 'rules_vec');

  const total = (db.prepare('SELECT COUNT(*) AS n FROM rules_chunks').get() as { n: number }).n;
  const pending = db
    .prepare(
      `SELECT id, chapter, section, heading, text, audience FROM rules_chunks
       ${hasTable ? 'WHERE id NOT IN (SELECT chunk_id FROM rules_vec)' : ''} ORDER BY id`
    )
    .all() as ChunkRow[];

  const prefix = documentPrefix(model);
  let embedded = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await embed(batch.map((c) => `${prefix}${citation(c)}\n\n${c.text}`));
    db.transaction(() => {
      if (!hasTable) {
        db.exec(`CREATE VIRTUAL TABLE rules_vec USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding float[${vectors[0]!.length}] distance_metric=cosine,
          audience TEXT
        )`);
        setMeta.run('embed_model', model);
        setMeta.run('embed_dims', String(vectors[0]!.length));
        hasTable = true;
      }
      const insert = db.prepare(
        'INSERT INTO rules_vec (chunk_id, embedding, audience) VALUES (?, ?, ?)'
      );
      batch.forEach((c, j) => insert.run(BigInt(c.id), new Float32Array(vectors[j]!), c.audience));
    })();
    embedded += batch.length;
    options.onProgress?.(total - pending.length + embedded, total);
  }
  return { embedded, total };
}

export function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
      .get(name) !== undefined
  );
}
