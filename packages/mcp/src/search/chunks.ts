import type Database from 'better-sqlite3';
import type { Audience } from '../importer/importer.js';

export interface Piece {
  /** `##` heading, or `## › ###` path, within the row; empty before the first heading. */
  heading: string;
  text: string;
}

/** Pieces shorter than this merge into a neighbor. */
const MIN_CHARS = 300;
/** Pieces longer than this split at paragraph boundaries. */
const MAX_CHARS = 1500;

/** Splits a rules row's Markdown on its `##`/`###` headings into citable pieces. */
export function chunkMarkdown(markdown: string): Piece[] {
  const pieces: { heading: string; blocks: string[] }[] = [];
  let h2 = '';
  for (const block of markdown.split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const match = /^(#{2,3})\s+(.+)$/.exec(lines[0]!);
    if (match) {
      const title = match[2]!.trim();
      if (match[1] === '##') h2 = title;
      const heading = match[1] === '##' || h2 === '' ? title : `${h2} › ${title}`;
      pieces.push({ heading, blocks: [] });
      lines.shift();
    } else if (pieces.length === 0) {
      pieces.push({ heading: '', blocks: [] });
    }
    const rest = lines.join('\n').trim();
    if (rest !== '') pieces.at(-1)!.blocks.push(rest);
  }

  const length = (blocks: string[]) => blocks.join('\n\n').length;
  const isParent = (parent: string, child: string) =>
    parent === '' || child === parent || child.startsWith(`${parent} › `);
  let i = 0;
  while (i < pieces.length) {
    const piece = pieces[i]!;
    const next = pieces[i + 1];
    const prev = pieces[i - 1];
    if (length(piece.blocks) >= MIN_CHARS) {
      i++;
    } else if (next && isParent(piece.heading, next.heading)) {
      // The merged piece takes the parent heading, so the child's title moves into its text.
      next.blocks.unshift(...piece.blocks, ...label(next.heading, piece.heading));
      next.heading = piece.heading;
      pieces.splice(i, 1);
    } else if (prev) {
      prev.blocks.push(...label(piece.heading, prev.heading), ...piece.blocks);
      pieces.splice(i, 1);
    } else {
      i++;
    }
  }

  return pieces
    .filter((p) => p.blocks.length > 0)
    .flatMap((p) => splitBlocks(p.blocks).map((text) => ({ heading: p.heading, text })));
}

/** A bold title line for a heading merged under another, so its words stay searchable. */
function label(heading: string, under: string): string[] {
  return heading === '' || heading === under ? [] : [`**${heading.split(' › ').at(-1)}**`];
}

/** Groups blocks into runs of at most MAX_CHARS; a single longer block stays whole. */
function splitBlocks(blocks: string[]): string[] {
  const runs: string[] = [];
  let run = '';
  for (const block of blocks) {
    if (run !== '' && run.length + 2 + block.length > MAX_CHARS) {
      runs.push(run);
      run = '';
    }
    run = run === '' ? block : `${run}\n\n${block}`;
  }
  if (run !== '') runs.push(run);
  return runs;
}

/** `Combat › The Order of Combat › Initiative`, skipping empty or repeated parts. */
export function citation(c: { chapter: string; section: string; heading: string }): string {
  return [c.chapter, c.section, c.heading]
    .filter((part, i, parts) => part !== '' && part !== parts[i - 1])
    .join(' › ');
}

interface ParentRow {
  slug: string;
  name: string;
  source: string;
  audience: Audience;
  raw_json: string;
}

/** Creates rules_chunks and rules_chunks_fts from the rules_sections, conditions and glossary tables. Returns the chunk count. */
export function buildRulesChunks(db: Database.Database): number {
  db.exec(`CREATE TABLE rules_chunks (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    chapter TEXT NOT NULL,
    section TEXT NOT NULL,
    heading TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    audience TEXT NOT NULL,
    position INTEGER NOT NULL
  )`);
  db.exec(`CREATE VIRTUAL TABLE rules_chunks_fts USING fts5(
    chapter, section, heading, text,
    content='rules_chunks', content_rowid='id', tokenize='porter unicode61'
  )`);

  const chapters = new Map(
    (
      db.prepare('SELECT ruleset, name FROM rules_sections WHERE position = 0').all() as {
        ruleset: string;
        name: string;
      }[]
    ).map((r) => [r.ruleset, r.name])
  );
  const sections = db
    .prepare('SELECT slug, name, source, audience, raw_json, ruleset FROM rules_sections')
    .all() as (ParentRow & { ruleset: string })[];
  const conditions = db
    .prepare('SELECT slug, name, source, audience, raw_json FROM conditions')
    .all() as ParentRow[];
  const glossary = db
    .prepare('SELECT slug, name, source, audience, raw_json FROM glossary')
    .all() as ParentRow[];

  const insert = db.prepare(`INSERT INTO rules_chunks
    (kind, slug, chapter, section, heading, text, source, audience, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let count = 0;
  const desc = (r: ParentRow) => String((JSON.parse(r.raw_json) as { desc?: unknown }).desc ?? '');
  db.transaction(() => {
    for (const r of sections) {
      const chapter = chapters.get(r.ruleset) ?? r.name;
      chunkMarkdown(desc(r)).forEach((p, position) => {
        insert.run(
          'rules_sections',
          r.slug,
          chapter,
          r.name,
          p.heading,
          p.text,
          r.source,
          r.audience,
          position
        );
        count++;
      });
    }
    for (const r of conditions) {
      const text = desc(r).trim();
      if (text === '') continue;
      insert.run('conditions', r.slug, 'Conditions', r.name, '', text, r.source, r.audience, 0);
      count++;
    }
    for (const r of glossary) {
      chunkMarkdown(desc(r)).forEach((p, position) => {
        insert.run(
          'glossary',
          r.slug,
          'Rules Glossary',
          r.name,
          p.heading,
          p.text,
          r.source,
          r.audience,
          position
        );
        count++;
      });
    }
    db.exec("INSERT INTO rules_chunks_fts(rules_chunks_fts) VALUES ('rebuild')");
  })();
  return count;
}
