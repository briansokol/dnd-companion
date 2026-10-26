import { describe, expect, it } from 'vitest';
import { rulesDb } from '../testing/rules-db.js';
import { chunkMarkdown, citation } from './chunks.js';

describe('chunkMarkdown', () => {
  it('splits on ## and ### and keeps the heading path', () => {
    const md = `Intro ${'a'.repeat(400)}\n\n## Initiative\n\n${'b'.repeat(400)}\n\n### Surprise\n\n${'c'.repeat(400)}\n\n## Your Turn\n\n${'d'.repeat(400)}`;
    expect(chunkMarkdown(md).map((p) => p.heading)).toEqual([
      '',
      'Initiative',
      'Initiative › Surprise',
      'Your Turn'
    ]);
  });

  it('merges a short parent intro into its first subsection under the parent heading', () => {
    const md = `## Cover\n\nShort intro.\n\n### Half Cover\n\n${'h'.repeat(400)}`;
    expect(chunkMarkdown(md)).toEqual([
      { heading: 'Cover', text: `Short intro.\n\n**Half Cover**\n\n${'h'.repeat(400)}` }
    ]);
  });

  it('merges a short trailing piece into the previous one and keeps its heading', () => {
    const md = `## A\n\n${'a'.repeat(400)}\n\n## B\n\nTiny.`;
    expect(chunkMarkdown(md)).toEqual([
      { heading: 'A', text: `${'a'.repeat(400)}\n\n**B**\n\nTiny.` }
    ]);
  });

  it('keeps a short heading-less row as one piece', () => {
    expect(chunkMarkdown('Just this.')).toEqual([{ heading: '', text: 'Just this.' }]);
  });

  it('splits long pieces at paragraph boundaries, each at most 1500 chars', () => {
    const para = 'p'.repeat(600);
    const pieces = chunkMarkdown(`## Long\n\n${[para, para, para, para].join('\n\n')}`);
    expect(pieces.length).toBe(2);
    expect(pieces.every((p) => p.heading === 'Long' && p.text.length <= 1500)).toBe(true);
  });

  it('never splits a single table or list block', () => {
    const table = [
      '|1d100|Trinket|',
      '|---|---|',
      ...Array.from({ length: 100 }, (_, i) => `|${i}|${'x'.repeat(30)}|`)
    ].join('\n');
    expect(chunkMarkdown(table)).toEqual([{ heading: '', text: table }]);
  });
});

describe('citation', () => {
  it('joins chapter, section and heading and skips empty or repeated parts', () => {
    expect(
      citation({ chapter: 'Combat', section: 'The Order of Combat', heading: 'Initiative' })
    ).toBe('Combat › The Order of Combat › Initiative');
    expect(citation({ chapter: 'Combat', section: 'Combat', heading: '' })).toBe('Combat');
    expect(citation({ chapter: 'Conditions', section: 'Prone', heading: '' })).toBe(
      'Conditions › Prone'
    );
  });
});

describe('buildRulesChunks', () => {
  const db = rulesDb({
    sections: [
      {
        slug: 'combat',
        name: 'Combat',
        ruleset: 'combat',
        position: 0,
        audience: 'player',
        desc: 'Combat intro.'
      },
      {
        slug: 'combat_cover',
        name: 'Cover',
        ruleset: 'combat',
        position: 6,
        audience: 'player',
        desc: 'Walls give cover.'
      },
      {
        slug: 'secret_rules',
        name: 'Secret Rules',
        ruleset: 'secret',
        position: 0,
        audience: 'dm',
        desc: 'Hidden.'
      }
    ],
    conditions: [
      { slug: 'prone', name: 'Prone', desc: 'You are on the ground.' },
      { slug: 'grappled', name: 'Grappled', desc: 'Your Speed is 0 while grappled.' }
    ],
    glossary: [
      { slug: 'burning', name: 'Burning', desc: 'A burning creature takes 1d4 Fire damage.' },
      {
        slug: 'stat-block',
        name: 'Stat Block',
        desc: [1, 2, 3, 4].map((i) => `**Part ${i}.** ${'s'.repeat(600)}`).join('\n\n')
      }
    ]
  });
  const chunk = (slug: string) =>
    db.prepare('SELECT * FROM rules_chunks WHERE slug = ?').get(slug) as Record<string, unknown>;

  it('writes one row per piece with chapter, section, audience and source from the parent', () => {
    expect(chunk('combat_cover')).toMatchObject({
      kind: 'rules_sections',
      chapter: 'Combat',
      section: 'Cover',
      heading: '',
      text: 'Walls give cover.',
      audience: 'player',
      source: 'srd-2024',
      position: 0
    });
    expect(chunk('secret_rules')).toMatchObject({ audience: 'dm', chapter: 'Secret Rules' });
    expect(chunk('prone')).toMatchObject({
      kind: 'conditions',
      chapter: 'Conditions',
      section: 'Prone',
      heading: ''
    });
  });

  it('writes glossary entries under Rules Glossary, split like rules sections', () => {
    expect(chunk('burning')).toMatchObject({
      kind: 'glossary',
      chapter: 'Rules Glossary',
      section: 'Burning',
      heading: '',
      text: 'A burning creature takes 1d4 Fire damage.',
      audience: 'player',
      position: 0
    });
    const positions = db
      .prepare("SELECT position FROM rules_chunks WHERE slug = 'stat-block' ORDER BY position")
      .all();
    expect(positions).toEqual([{ position: 0 }, { position: 1 }]);
  });

  it('indexes chunks in FTS with stemming', () => {
    const slugs = db
      .prepare(
        `SELECT slug FROM rules_chunks_fts JOIN rules_chunks ON rules_chunks.id = rules_chunks_fts.rowid
         WHERE rules_chunks_fts MATCH 'grappling'`
      )
      .all()
      .map((r) => (r as { slug: string }).slug);
    expect(slugs).toEqual(['grappled']);
  });
});
