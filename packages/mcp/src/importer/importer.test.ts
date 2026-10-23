import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { searchNames } from '../search/names.js';
import { RULESET_AUDIENCE, runImport, type ImportOptions } from './importer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, '../../../../data/seed/conditions-2024.json');

// Recorded from api.open5e.com with limit=2. Spells span two pages; magicitems has one
// non-2024 item spliced in, because that endpoint ignores document__key.
const FIXTURES = JSON.parse(readFileSync(join(HERE, 'fixtures/open5e.json'), 'utf8')) as Record<
  string,
  unknown
>;

const fixtureFetch: typeof fetch = async (url) => {
  const body = FIXTURES[String(url)];
  return body ? new Response(JSON.stringify(body)) : new Response('not recorded', { status: 404 });
};

function options(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    baseUrl: 'https://api.open5e.com/v2',
    dbPath: join(mkdtempSync(join(tmpdir(), 'dnd-rules-')), 'rules.db'),
    seedPath: SEED_PATH,
    pageSize: 2,
    fetch: fixtureFetch,
    minimums: {},
    now: new Date('2026-10-23T12:00:00Z'),
    ...overrides
  };
}

function query<T>(dbPath: string, sql: string): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

describe('runImport', () => {
  it('writes every table and reports counts', async () => {
    const result = await runImport(options());

    expect(result.counts).toEqual({
      spells: 4,
      creatures: 2,
      items: 2,
      magic_items: 2,
      classes: 2,
      species: 2,
      backgrounds: 2,
      feats: 2,
      conditions: 15,
      rules_sections: 4
    });
  });

  it('keeps slug, name, source, audience and raw_json on every row', async () => {
    const { dbPath } = options();
    await runImport(options({ dbPath }));

    const [spell] = query<Record<string, unknown>>(
      dbPath,
      "SELECT * FROM spells WHERE slug = 'acid-arrow'"
    );
    expect(spell).toMatchObject({ name: 'Acid Arrow', source: 'srd-2024', audience: 'player' });
    expect(JSON.parse(spell!.raw_json as string)).toMatchObject({ key: 'srd-2024_acid-arrow' });

    const [condition] = query<Record<string, unknown>>(
      dbPath,
      "SELECT * FROM conditions WHERE slug = 'exhaustion'"
    );
    expect(condition).toMatchObject({ name: 'Exhaustion', source: 'srd-2024', audience: 'player' });
    expect(JSON.parse(condition!.raw_json as string).desc).toMatch(
      /You die if your Exhaustion level is 6/
    );
  });

  it('marks creatures and magic items dm-only and everything else player', async () => {
    const { dbPath } = options();
    await runImport(options({ dbPath }));

    const audiences = (table: string) =>
      query<{ audience: string }>(dbPath, `SELECT DISTINCT audience FROM ${table}`).map(
        (r) => r.audience
      );
    expect(audiences('creatures')).toEqual(['dm']);
    expect(audiences('magic_items')).toEqual(['dm']);
    for (const table of [
      'spells',
      'items',
      'classes',
      'species',
      'backgrounds',
      'feats',
      'conditions'
    ]) {
      expect(audiences(table)).toEqual(['player']);
    }
  });

  it('writes rules chunks for every rules section and condition', async () => {
    const { dbPath } = options();
    await runImport(options({ dbPath }));

    const parents = (kind: string) =>
      query<{ n: number }>(
        dbPath,
        `SELECT COUNT(DISTINCT slug) AS n FROM rules_chunks WHERE kind = '${kind}'`
      )[0]!.n;
    expect(parents('rules_sections')).toBe(4);
    expect(parents('conditions')).toBe(15);
  });

  it('drops magic items from other documents', async () => {
    const { dbPath } = options();
    await runImport(options({ dbPath }));

    const slugs = query<{ slug: string }>(dbPath, 'SELECT slug FROM magic_items ORDER BY slug').map(
      (r) => r.slug
    );
    expect(slugs).toEqual(['adamantine-armor-breastplate', 'adamantine-armor-chain-mail']);
  });

  it('fills the typed columns', async () => {
    const { dbPath } = options();
    await runImport(options({ dbPath }));

    expect(
      query(
        dbPath,
        "SELECT level, school, concentration, ritual FROM spells WHERE slug = 'acid-arrow'"
      )
    ).toEqual([{ level: 2, school: 'evocation', concentration: 0, ritual: 0 }]);
    expect(query(dbPath, "SELECT cr, type, size FROM creatures WHERE slug = 'aboleth'")).toEqual([
      { cr: 10, type: 'aberration', size: 'large' }
    ]);
    expect(query(dbPath, "SELECT category FROM items WHERE slug = 'acid'")).toEqual([
      { category: 'weapon' }
    ]);
    expect(
      query(
        dbPath,
        "SELECT rarity, category, requires_attunement FROM magic_items WHERE slug = 'adamantine-armor-breastplate'"
      )
    ).toEqual([{ rarity: 'uncommon', category: 'armor', requires_attunement: 0 }]);
    expect(query(dbPath, "SELECT subclass_of FROM classes WHERE slug = 'barbarian'")).toEqual([
      { subclass_of: null }
    ]);
    expect(query(dbPath, "SELECT type FROM feats WHERE slug = 'alert'")).toEqual([
      { type: 'Origin' }
    ]);
  });

  it('stores ruleset intros and rules as rules sections', async () => {
    const { dbPath } = options();
    await runImport(options({ dbPath }));

    expect(
      query(dbPath, 'SELECT slug, ruleset, position, audience FROM rules_sections ORDER BY slug')
    ).toEqual([
      { slug: 'combat', ruleset: 'combat', position: 0, audience: 'player' },
      {
        slug: 'create-your-character',
        ruleset: 'create-your-character',
        position: 0,
        audience: 'player'
      },
      { slug: 'd20-tests_ability-checks', ruleset: 'd20-tests', position: 1, audience: 'player' },
      {
        slug: 'the-six-abilities_ability-scores',
        ruleset: 'the-six-abilities',
        position: 1,
        audience: 'player'
      }
    ]);
  });

  it('defaults unmapped rulesets to dm and reports them', async () => {
    const { dbPath } = options();
    const withoutCombat = Object.fromEntries(
      Object.entries(RULESET_AUDIENCE).filter(([ruleset]) => ruleset !== 'combat')
    );
    const result = await runImport(options({ dbPath, rulesetAudience: withoutCombat }));

    expect(result.unmappedRulesets).toEqual(['combat']);
    expect(query(dbPath, "SELECT audience FROM rules_sections WHERE ruleset = 'combat'")).toEqual([
      { audience: 'dm' }
    ]);
  });

  it('records the import date and counts', async () => {
    const { dbPath } = options();
    const result = await runImport(options({ dbPath }));

    const meta = Object.fromEntries(
      query<{ key: string; value: string }>(dbPath, 'SELECT key, value FROM import_meta').map(
        (r) => [r.key, r.value]
      )
    );
    expect(meta.imported_at).toBe('2026-10-23T12:00:00.000Z');
    expect(meta.source).toBe('srd-2024');
    expect(JSON.parse(meta.counts!)).toEqual(result.counts);
    expect(JSON.parse(meta.unmapped_rulesets!)).toEqual([]);
  });

  it('indexes every table for name search', async () => {
    const { dbPath } = options();
    const result = await runImport(options({ dbPath }));

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(searchNames(db, 'acid arrow', { audience: 'player' }).matches[0]).toMatchObject({
        kind: 'spells',
        slug: 'acid-arrow',
        match: 'exact'
      });
    } finally {
      db.close();
    }
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
    expect(query(dbPath, 'SELECT COUNT(*) AS n FROM name_index')).toEqual([{ n: total }]);
  });

  it('rebuilds from scratch on every run', async () => {
    const { dbPath } = options();
    await runImport(options({ dbPath }));
    const stale = new Database(dbPath);
    stale.exec('CREATE TABLE leftover (x)');
    stale.close();

    const result = await runImport(options({ dbPath }));

    expect(result.counts.spells).toBe(4);
    expect(query(dbPath, "SELECT name FROM sqlite_master WHERE name = 'leftover'")).toEqual([]);
  });

  it('fails the sanity check and leaves the old database in place', async () => {
    const { dbPath } = options();
    writeFileSync(dbPath, 'previous');

    await expect(runImport(options({ dbPath, minimums: { spells: 339 } }))).rejects.toThrow(
      /spells: 4 < 339/
    );
    expect(readFileSync(dbPath, 'utf8')).toBe('previous');
    expect(existsSync(`${dbPath}.tmp`)).toBe(false);
  });
});
