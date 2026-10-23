import type Database from 'better-sqlite3';
import type { Audience } from '../importer/importer.js';

export interface NameHit {
  /** The rules.db table the row lives in. */
  kind: string;
  slug: string;
  name: string;
  match: 'exact' | 'prefix' | 'fuzzy' | 'suggestion';
}

export interface NameSearchResult {
  matches: NameHit[];
  /** Close misspellings, only when nothing matched. */
  suggestions: NameHit[];
}

const MAX_SUGGESTIONS = 5;

/** Indexes the normalized name of every row in `tables` into `name_index`. */
export function buildNameIndex(db: Database.Database, tables: string[]): void {
  db.exec(`CREATE VIRTUAL TABLE name_index USING fts5(
    norm, name UNINDEXED, kind UNINDEXED, slug UNINDEXED, audience UNINDEXED
  )`);
  const insert = db.prepare(
    'INSERT INTO name_index (norm, name, kind, slug, audience) VALUES (?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const table of tables) {
      const rows = db.prepare(`SELECT slug, name, audience FROM ${table}`).all() as {
        slug: string;
        name: string;
        audience: Audience;
      }[];
      for (const r of rows) insert.run(normalize(r.name), r.name, table, r.slug, r.audience);
    }
  })();
}

/**
 * Names containing every query word (the last as a prefix), ranked exact, prefix, then fuzzy.
 * `player` only sees player rows, which leaves out creatures and magic items.
 */
export function searchNames(
  db: Database.Database,
  query: string,
  options: { audience: Audience }
): NameSearchResult {
  const q = normalize(query);
  if (q === '') return { matches: [], suggestions: [] };

  const audiences = options.audience === 'player' ? ['player'] : ['player', 'dm'];
  const audienceSql = `audience IN (${audiences.map(() => '?').join(', ')})`;
  const fts = q
    .split(' ')
    .map((word, i, words) => `"${word}"${i === words.length - 1 ? '*' : ''}`)
    .join(' ');
  const rows = db
    .prepare(
      `SELECT norm, name, kind, slug FROM name_index WHERE name_index MATCH ? AND ${audienceSql}`
    )
    .all(fts, ...audiences) as IndexRow[];

  const tier = (norm: string) => (norm === q ? 0 : norm.startsWith(q) ? 1 : 2);
  const matches = rows
    .map((r) => ({ r, tier: tier(r.norm) }))
    .sort(
      (a, b) =>
        a.tier - b.tier || a.r.name.length - b.r.name.length || a.r.name.localeCompare(b.r.name)
    )
    .map(({ r, tier }) => hit(r, (['exact', 'prefix', 'fuzzy'] as const)[tier]!));
  if (matches.length > 0) return { matches, suggestions: [] };

  // Typo tolerance: a quarter of the query's length, at least one edit.
  const maxDistance = Math.max(1, Math.floor(q.length / 4));
  const suggestions = (
    db
      .prepare(`SELECT norm, name, kind, slug FROM name_index WHERE ${audienceSql}`)
      .all(...audiences) as IndexRow[]
  )
    .map((r) => ({ r, distance: editDistance(q, r.norm) }))
    .filter((s) => s.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.r.name.localeCompare(b.r.name))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ r }) => hit(r, 'suggestion'));
  return { matches: [], suggestions };
}

interface IndexRow {
  norm: string;
  name: string;
  kind: string;
  slug: string;
}

function hit(r: IndexRow, match: NameHit['match']): NameHit {
  return { kind: r.kind, slug: r.slug, name: r.name, match };
}

/** `Tasha's Hideous-Laughter` → `tashas hideous laughter`. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Edit distance where swapping two adjacent letters counts as one edit. */
function editDistance(a: string, b: string): number {
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j]!, prev2[j - 2]! + 1);
    }
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}
