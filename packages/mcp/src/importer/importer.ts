import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DOCUMENT_KEY, fetchAll, type FetchAllOptions, type Open5eRecord } from './open5e.js';

export type Audience = 'player' | 'dm';

/** Spec call 13a: rules sections are tagged by ruleset; anything not listed is dm-only. */
export const RULESET_AUDIENCE: Record<string, Audience> = {
  combat: 'player',
  'create-your-character': 'player',
  'd20-tests': 'player',
  'damage-and-healing': 'player',
  exploration: 'player',
  multiclassing: 'player',
  proficiency: 'player',
  'rhythm-of-play': 'player',
  'social-interaction': 'player',
  'the-six-abilities': 'player',
  trinkets: 'player'
};

/** Lower bounds from the srd-2024 counts at the time of writing. */
export const EXPECTED_MINIMUMS: Partial<Record<TableName, number>> = {
  spells: 339,
  creatures: 331,
  items: 203,
  magic_items: 760,
  classes: 24,
  species: 9,
  backgrounds: 4,
  feats: 17,
  conditions: 15,
  rules_sections: 67
};

type Value = string | number | null;

interface ColumnDef {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL';
}

interface Column extends ColumnDef {
  value: (record: Open5eRecord) => Value;
}

interface Table {
  endpoint: string;
  audience: Audience;
  columns: Column[];
}

const TABLES = {
  spells: {
    endpoint: 'spells',
    audience: 'player',
    columns: [
      { name: 'level', type: 'INTEGER', value: (r) => num(r.level) },
      { name: 'school', type: 'TEXT', value: (r) => refKey(r.school) },
      { name: 'concentration', type: 'INTEGER', value: (r) => bool(r.concentration) },
      { name: 'ritual', type: 'INTEGER', value: (r) => bool(r.ritual) }
    ]
  },
  creatures: {
    endpoint: 'creatures',
    audience: 'dm',
    columns: [
      { name: 'cr', type: 'REAL', value: (r) => num(r.challenge_rating) },
      { name: 'type', type: 'TEXT', value: (r) => refKey(r.type) },
      { name: 'size', type: 'TEXT', value: (r) => refKey(r.size) }
    ]
  },
  items: {
    endpoint: 'items',
    audience: 'player',
    columns: [{ name: 'category', type: 'TEXT', value: (r) => refKey(r.category) }]
  },
  magic_items: {
    endpoint: 'magicitems',
    audience: 'dm',
    columns: [
      { name: 'rarity', type: 'TEXT', value: (r) => refKey(r.rarity) },
      { name: 'category', type: 'TEXT', value: (r) => refKey(r.category) },
      { name: 'requires_attunement', type: 'INTEGER', value: (r) => bool(r.requires_attunement) }
    ]
  },
  classes: {
    endpoint: 'classes',
    audience: 'player',
    columns: [
      { name: 'subclass_of', type: 'TEXT', value: (r) => slugOrNull(refKey(r.subclass_of)) }
    ]
  },
  species: {
    endpoint: 'species',
    audience: 'player',
    columns: [
      { name: 'subspecies_of', type: 'TEXT', value: (r) => slugOrNull(refKey(r.subspecies_of)) }
    ]
  },
  backgrounds: { endpoint: 'backgrounds', audience: 'player', columns: [] },
  feats: {
    endpoint: 'feats',
    audience: 'player',
    columns: [{ name: 'type', type: 'TEXT', value: (r) => str(r.type) }]
  }
} satisfies Record<string, Table>;

type TableName = keyof typeof TABLES | 'conditions' | 'rules_sections';

const seedSchema = z.object({
  conditions: z.array(z.object({ slug: z.string(), name: z.string(), desc: z.string() }))
});

export interface ImportOptions extends Omit<FetchAllOptions, 'baseUrl'> {
  baseUrl: string;
  dbPath: string;
  /** `data/seed/conditions-2024.json`. */
  seedPath: string;
  rulesetAudience?: Record<string, Audience>;
  /** Fails the import when a table has fewer rows. */
  minimums?: Partial<Record<TableName, number>>;
  now?: Date;
}

export interface ImportResult {
  counts: Record<TableName, number>;
  unmappedRulesets: string[];
}

/** Rebuilds `rules.db` from Open5e srd-2024 and the conditions seed, replacing it only on success. */
export async function runImport(options: ImportOptions): Promise<ImportResult> {
  const fetched = new Map<string, Open5eRecord[]>();
  for (const endpoint of [...Object.values(TABLES).map((t) => t.endpoint), 'rulesets', 'rules']) {
    // items and magicitems also return other documents despite document__key, so filter on the record's own.
    fetched.set(
      endpoint,
      (await fetchAll(endpoint, options)).filter((r) => documentKey(r) === DOCUMENT_KEY)
    );
  }
  const seed = seedSchema.parse(JSON.parse(readFileSync(options.seedPath, 'utf8')));

  const tmpPath = `${options.dbPath}.tmp`;
  mkdirSync(dirname(options.dbPath), { recursive: true });
  rmSync(tmpPath, { force: true });
  const db = new Database(tmpPath);
  try {
    const counts = {} as Record<TableName, number>;
    const insert = (table: TableName, extra: ColumnDef[], rows: Row[]) => {
      createTable(db, table, extra);
      writeRows(db, table, extra, rows);
      counts[table] = rows.length;
    };

    for (const [name, table] of Object.entries(TABLES) as [keyof typeof TABLES, Table][]) {
      const rows = fetched.get(table.endpoint)!.map((r) => ({
        slug: slug(r.key),
        name: r.name,
        audience: table.audience,
        raw: r,
        extra: table.columns.map((c) => c.value(r))
      }));
      insert(name, table.columns, rows);
    }

    insert(
      'conditions',
      [],
      seed.conditions.map((c) => ({
        slug: c.slug,
        name: c.name,
        audience: 'player',
        raw: c,
        extra: []
      }))
    );

    const rulesetAudience = options.rulesetAudience ?? RULESET_AUDIENCE;
    const unmapped = new Set<string>();
    const audienceFor = (ruleset: string): Audience => {
      if (rulesetAudience[ruleset]) return rulesetAudience[ruleset];
      unmapped.add(ruleset);
      return 'dm';
    };
    const sectionRow = (r: Open5eRecord, ruleset: string, position: number): Row => ({
      slug: slug(r.key),
      name: r.name,
      audience: audienceFor(ruleset),
      raw: r,
      extra: [ruleset, position]
    });
    insert(
      'rules_sections',
      [
        { name: 'ruleset', type: 'TEXT' },
        { name: 'position', type: 'INTEGER' }
      ],
      [
        // A ruleset's own text is its intro, ahead of its numbered rules.
        ...fetched.get('rulesets')!.map((r) => sectionRow(r, slug(r.key), 0)),
        ...fetched
          .get('rules')!
          .map((r) => sectionRow(r, slug(String(r.ruleset)), num(r.index) ?? 0))
      ]
    );

    const unmappedRulesets = [...unmapped].sort();
    const problems = Object.entries(options.minimums ?? {})
      .filter(([table, min]) => counts[table as TableName] < min)
      .map(([table, min]) => `${table}: ${counts[table as TableName]} < ${min}`);
    if (problems.length > 0)
      throw new Error(`Row counts failed the sanity check:\n  ${problems.join('\n  ')}`);

    db.exec('CREATE TABLE import_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const meta = db.prepare('INSERT INTO import_meta (key, value) VALUES (?, ?)');
    meta.run('imported_at', (options.now ?? new Date()).toISOString());
    meta.run('source', DOCUMENT_KEY);
    meta.run('counts', JSON.stringify(counts));
    meta.run('unmapped_rulesets', JSON.stringify(unmappedRulesets));
    db.close();

    renameSync(tmpPath, options.dbPath);
    return { counts, unmappedRulesets };
  } catch (error) {
    db.close();
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

interface Row {
  slug: string;
  name: string;
  audience: Audience;
  raw: unknown;
  extra: Value[];
}

function createTable(db: Database.Database, table: TableName, extra: ColumnDef[]): void {
  db.exec(`CREATE TABLE ${table} (
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    audience TEXT NOT NULL CHECK (audience IN ('player', 'dm')),
    ${extra.map((c) => `${c.name} ${c.type},`).join('\n    ')}
    raw_json TEXT NOT NULL,
    PRIMARY KEY (source, slug)
  )`);
}

function writeRows(db: Database.Database, table: TableName, extra: ColumnDef[], rows: Row[]): void {
  const names = ['slug', 'name', 'source', 'audience', ...extra.map((c) => c.name), 'raw_json'];
  const stmt = db.prepare(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
  );
  db.transaction(() => {
    for (const row of rows) {
      stmt.run(
        row.slug,
        row.name,
        DOCUMENT_KEY,
        row.audience,
        ...row.extra,
        JSON.stringify(row.raw)
      );
    }
  })();
}

/** `srd-2024_acid-arrow` → `acid-arrow`. */
function slug(key: string): string {
  return key.startsWith(`${DOCUMENT_KEY}_`) ? key.slice(DOCUMENT_KEY.length + 1) : key;
}

function slugOrNull(key: string | null): string | null {
  return key === null ? null : slug(key);
}

/** Rules carry `document` as a key; everything else as `{ key, ... }`. */
function documentKey(record: Open5eRecord): string | null {
  return typeof record.document === 'string' ? record.document : refKey(record.document);
}

function refKey(value: unknown): string | null {
  return typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    typeof value.key === 'string'
    ? value.key
    : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: unknown): number | null {
  return typeof value === 'boolean' ? Number(value) : null;
}
