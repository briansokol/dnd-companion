import Database from 'better-sqlite3';
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
