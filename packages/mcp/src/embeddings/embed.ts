import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

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
