import Database from 'better-sqlite3';
import type { Embedder } from '../embeddings/embed.js';
import type { Audience } from '../importer/importer.js';
import { buildRulesChunks } from '../search/chunks.js';

export interface SectionRow {
  slug: string;
  name: string;
  ruleset: string;
  position: number;
  audience: Audience;
  desc: string;
}

export interface ConditionRow {
  slug: string;
  name: string;
  audience?: Audience;
  desc: string;
}

/** An in-memory rules.db holding just rules_sections and conditions, with chunks built. */
export function rulesDb(rows: {
  sections?: SectionRow[];
  conditions?: ConditionRow[];
}): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE rules_sections (
    slug TEXT, name TEXT, source TEXT, audience TEXT, ruleset TEXT, position INTEGER, raw_json TEXT
  )`);
  db.exec(
    'CREATE TABLE conditions (slug TEXT, name TEXT, source TEXT, audience TEXT, raw_json TEXT)'
  );
  const section = db.prepare('INSERT INTO rules_sections VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const s of rows.sections ?? []) {
    section.run(
      s.slug,
      s.name,
      'srd-2024',
      s.audience,
      s.ruleset,
      s.position,
      JSON.stringify({ desc: s.desc })
    );
  }
  const condition = db.prepare('INSERT INTO conditions VALUES (?, ?, ?, ?, ?)');
  for (const c of rows.conditions ?? []) {
    condition.run(
      c.slug,
      c.name,
      'srd-2024',
      c.audience ?? 'player',
      JSON.stringify({ desc: c.desc })
    );
  }
  buildRulesChunks(db);
  return db;
}

/** A bag-of-words embedder over `vocab` (substring counts), recording every call's texts. */
export function fakeEmbedder(vocab: string[]): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  const embed = async (texts: string[]) => {
    calls.push(texts);
    return texts.map((t) => {
      const lower = t.toLowerCase();
      // The constant component keeps every vector non-zero for cosine distance.
      return [...vocab.map((w) => lower.split(w).length - 1), 0.01];
    });
  };
  return Object.assign(embed, { calls });
}
