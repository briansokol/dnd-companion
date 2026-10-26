import type Database from 'better-sqlite3';
import { queryPrefix, tableExists, type Embedder } from '../embeddings/embed.js';
import type { Audience } from '../importer/importer.js';

export interface RuleChunk {
  kind: 'rules_sections' | 'conditions' | 'glossary';
  slug: string;
  chapter: string;
  section: string;
  heading: string;
  source: string;
  text: string;
  score: number;
}

export interface RulesSearchResult {
  /** `fts` when vectors were unusable and only keyword search ran. */
  mode: 'hybrid' | 'fts';
  chunks: RuleChunk[];
}

export interface RulesSearchOptions {
  audience: Audience;
  /** The configured EMBED_MODEL; vectors built with another model are ignored. */
  model: string;
  embed: Embedder;
  limit?: number;
  warn?: (message: string) => void;
}

/** Candidates each half contributes to the merge. */
const CANDIDATES = 20;
/** Reciprocal rank fusion constant. */
const RRF_K = 60;

const STOP_WORDS = new Set(
  (
    'a an and are as at be by can do does for from get gets have how i if in is it its me my ' +
    'of on or so that the their them there this to use what whats when where which who why ' +
    'will with you your'
  ).split(' ')
);

/** Hybrid FTS + vector search over rules_chunks, merged by reciprocal rank. The caller loads sqlite-vec. */
export async function searchRules(
  db: Database.Database,
  question: string,
  options: RulesSearchOptions
): Promise<RulesSearchResult> {
  if (!tableExists(db, 'rules_chunks')) {
    throw new Error('rules.db has no rules_chunks; run pnpm data:import');
  }
  const { model, limit = 5, warn = console.warn } = options;
  const audiences = options.audience === 'player' ? ['player'] : ['player', 'dm'];
  const audienceIn = `(${audiences.map(() => '?').join(', ')})`;

  const terms = (question.toLowerCase().match(/\p{L}[\p{L}\p{N}']*/gu) ?? [])
    .map((t) => t.replace(/'/g, ''))
    .filter((t) => !STOP_WORDS.has(t));
  const ftsIds =
    terms.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT rules_chunks.id FROM rules_chunks_fts
               JOIN rules_chunks ON rules_chunks.id = rules_chunks_fts.rowid
               WHERE rules_chunks_fts MATCH ? AND rules_chunks.audience IN ${audienceIn}
               ORDER BY bm25(rules_chunks_fts) LIMIT ${CANDIDATES}`
            )
            .all(terms.map((t) => `"${t}"`).join(' OR '), ...audiences) as { id: number }[]
        ).map((r) => r.id);

  let vecIds: number[] | null = null;
  try {
    // Inside the try: without sqlite-vec loaded, reading rules_vec throws "no such module".
    const unusable = vectorProblem(db, model);
    if (unusable) throw new Error(unusable);
    const [vector] = await options.embed([`${queryPrefix(model)}${question}`]);
    vecIds = (
      db
        .prepare(
          `SELECT chunk_id FROM rules_vec
             WHERE embedding MATCH ? AND k = ${CANDIDATES} AND audience IN ${audienceIn}
             ORDER BY distance`
        )
        .all(new Float32Array(vector!), ...audiences) as { chunk_id: number }[]
    ).map((r) => r.chunk_id);
  } catch (error) {
    warn(`Rules search is keyword-only: ${error instanceof Error ? error.message : error}`);
  }

  const ranked = new Map<number, { score: number; ftsRank: number }>();
  const add = (ids: number[], fromFts: boolean) =>
    ids.forEach((id, i) => {
      const entry = ranked.get(id) ?? { score: 0, ftsRank: Infinity };
      entry.score += 1 / (RRF_K + i + 1);
      if (fromFts) entry.ftsRank = i + 1;
      ranked.set(id, entry);
    });
  add(ftsIds, true);
  add(vecIds ?? [], false);
  const top = [...ranked.entries()]
    .sort(([, a], [, b]) => b.score - a.score || a.ftsRank - b.ftsRank)
    .slice(0, limit);

  const get = db.prepare(
    'SELECT kind, slug, chapter, section, heading, source, text FROM rules_chunks WHERE id = ?'
  );
  return {
    mode: vecIds === null ? 'fts' : 'hybrid',
    chunks: top.map(([id, { score }]) => ({ ...(get.get(id) as Omit<RuleChunk, 'score'>), score }))
  };
}

/** Why rules_vec can't serve `model`, or null when it can. */
function vectorProblem(db: Database.Database, model: string): string | null {
  if (!tableExists(db, 'rules_vec')) return 'no vectors; run pnpm data:embed';
  const stored = tableExists(db, 'import_meta')
    ? (
        db.prepare("SELECT value FROM import_meta WHERE key = 'embed_model'").get() as
          { value: string } | undefined
      )?.value
    : undefined;
  if (stored !== model) {
    return `vectors were built with ${stored ?? 'an unknown model'}, not ${model}; run pnpm data:embed`;
  }
  if (db.prepare('SELECT 1 FROM rules_vec LIMIT 1').get() === undefined) {
    return 'no vectors; run pnpm data:embed';
  }
  return null;
}
