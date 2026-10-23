import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildNameIndex, searchNames } from './names.js';

const ROWS: Record<string, [slug: string, name: string, audience: 'player' | 'dm'][]> = {
  spells: [
    ['fireball', 'Fireball', 'player'],
    ['delayed-blast-fireball', 'Delayed Blast Fireball', 'player'],
    ['fire-bolt', 'Fire Bolt', 'player'],
    ['hideous-laughter', "Tasha's Hideous Laughter", 'player']
  ],
  creatures: [
    ['beholder', 'Beholder', 'dm'],
    ['fire-giant', 'Fire Giant', 'dm']
  ],
  magic_items: [['fireball-necklace', 'Necklace of Fireballs', 'dm']],
  conditions: [['prone', 'Prone', 'player']]
};

let db: Database.Database;

beforeAll(() => {
  db = new Database(':memory:');
  for (const [table, rows] of Object.entries(ROWS)) {
    db.exec(`CREATE TABLE ${table} (slug TEXT, name TEXT, audience TEXT)`);
    const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`);
    for (const row of rows) insert.run(...row);
  }
  buildNameIndex(db, Object.keys(ROWS));
});

const names = (query: string, audience: 'player' | 'dm' = 'dm') =>
  searchNames(db, query, { audience }).matches.map((m) => m.name);

describe('searchNames', () => {
  it('ranks the exact match first, then prefix, then fuzzy', () => {
    expect(searchNames(db, 'fireball', { audience: 'dm' }).matches).toEqual([
      { kind: 'spells', slug: 'fireball', name: 'Fireball', match: 'exact' },
      {
        kind: 'magic_items',
        slug: 'fireball-necklace',
        name: 'Necklace of Fireballs',
        match: 'fuzzy'
      },
      {
        kind: 'spells',
        slug: 'delayed-blast-fireball',
        name: 'Delayed Blast Fireball',
        match: 'fuzzy'
      }
    ]);
  });

  it('treats a partial last word as a prefix', () => {
    const { matches } = searchNames(db, 'fire', { audience: 'player' });
    expect(matches.slice(0, 2)).toMatchObject([
      { name: 'Fireball', match: 'prefix' },
      { name: 'Fire Bolt', match: 'prefix' }
    ]);
    expect(matches.map((m) => m.name)).toContain('Delayed Blast Fireball');
  });

  it('ignores case', () => {
    expect(names('FIREBALL')[0]).toBe('Fireball');
  });

  it('ignores punctuation', () => {
    expect(names("tasha's hideous laughter")).toEqual(["Tasha's Hideous Laughter"]);
    expect(names('tashas hideous laughter')).toEqual(["Tasha's Hideous Laughter"]);
    expect(names('Tasha’s')).toEqual(["Tasha's Hideous Laughter"]);
    expect(names('fire-bolt')).toEqual(['Fire Bolt']);
  });

  it('matches all words in any order', () => {
    expect(names('blast fireball')).toEqual(['Delayed Blast Fireball']);
  });

  it('returns nothing for no match, with typo suggestions', () => {
    expect(searchNames(db, 'beholdr', { audience: 'dm' })).toEqual({
      matches: [],
      suggestions: [{ kind: 'creatures', slug: 'beholder', name: 'Beholder', match: 'suggestion' }]
    });
    expect(searchNames(db, 'behodler', { audience: 'dm' }).suggestions).toMatchObject([
      { name: 'Beholder' }
    ]);
    expect(searchNames(db, 'xyzzy', { audience: 'dm' })).toEqual({ matches: [], suggestions: [] });
  });

  it('returns nothing for a query with no words', () => {
    expect(searchNames(db, " '- ", { audience: 'dm' })).toEqual({ matches: [], suggestions: [] });
  });

  it('never shows creatures or magic items to players', () => {
    expect(names('fire', 'player')).not.toContain('Fire Giant');
    expect(names('fireballs', 'player')).toEqual([]);
    expect(searchNames(db, 'beholdr', { audience: 'player' }).suggestions).toEqual([]);
  });
});
