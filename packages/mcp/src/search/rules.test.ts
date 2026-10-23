import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { embedChunks, loadVec, type Embedder } from '../embeddings/embed.js';
import { fakeEmbedder, rulesDb } from '../testing/rules-db.js';
import { searchRules, type RulesSearchOptions } from './rules.js';

const MODEL = 'nomic-embed-text';
const embed = fakeEmbedder(['cover', 'wall', 'fire', 'burn', 'prone', 'grappl']);

function fixture(): Database.Database {
  const db = rulesDb({
    sections: [
      {
        slug: 'combat',
        name: 'Combat',
        ruleset: 'combat',
        position: 0,
        audience: 'player',
        desc: 'Rounds and turns.'
      },
      {
        slug: 'combat_cover',
        name: 'Cover',
        ruleset: 'combat',
        position: 6,
        audience: 'player',
        desc: 'A wall gives half cover. Stay behind a wall for more cover.'
      },
      {
        slug: 'exploration',
        name: 'Exploration',
        ruleset: 'exploration',
        position: 0,
        audience: 'player',
        desc: 'Travel and light.'
      },
      {
        slug: 'exploration_hazards',
        name: 'Hazards',
        ruleset: 'exploration',
        position: 5,
        audience: 'player',
        desc: 'A burning creature takes fire damage. Burn, burn.'
      },
      {
        slug: 'secret_rules',
        name: 'Secret Rules',
        ruleset: 'secret',
        position: 0,
        audience: 'dm',
        desc: 'Cover cover fire wall cover wall fire cover wall.'
      }
    ],
    conditions: [
      { slug: 'prone', name: 'Prone', desc: 'You are on the ground.' },
      { slug: 'grappled', name: 'Grappled', desc: 'Your Speed is 0 while grappled.' }
    ]
  });
  loadVec(db);
  return db;
}

let db: Database.Database;
beforeAll(async () => {
  db = fixture();
  await embedChunks(db, { model: MODEL, embed });
});

const search = (question: string, options: Partial<RulesSearchOptions> = {}, on = db) =>
  searchRules(on, question, {
    audience: 'player',
    model: MODEL,
    embed,
    warn: () => {},
    ...options
  });
const slugs = async (...args: Parameters<typeof search>) =>
  (await search(...args)).chunks.map((c) => c.slug);

describe('searchRules', () => {
  it('finds a chunk the FTS half misses', async () => {
    const result = await search('aflameburn');
    expect(result.mode).toBe('hybrid');
    expect(result.chunks[0]?.slug).toBe('exploration_hazards');
  });

  it('ranks a chunk found by both halves above one found by either', async () => {
    expect((await slugs('cover behind a wall'))[0]).toBe('combat_cover');
  });

  it('never returns dm chunks to players from either half', async () => {
    expect(await slugs('cover fire wall', { limit: 20 })).not.toContain('secret_rules');
    expect((await slugs('cover fire wall', { audience: 'dm' }))[0]).toBe('secret_rules');
  });

  it('returns citation fields', async () => {
    const [first] = (await search('cover behind a wall')).chunks;
    expect(first).toMatchObject({
      kind: 'rules_sections',
      slug: 'combat_cover',
      chapter: 'Combat',
      section: 'Cover',
      heading: '',
      source: 'srd-2024',
      text: 'A wall gives half cover. Stay behind a wall for more cover.'
    });
    expect(first!.score).toBeGreaterThan(0);
  });

  describe('falls back to FTS', () => {
    const expectFallback = async (on: Database.Database, options: Partial<RulesSearchOptions>) => {
      const warnings: string[] = [];
      const result = await search('cover', { ...options, warn: (m) => warnings.push(m) }, on);
      expect(result.mode).toBe('fts');
      expect(result.chunks.map((c) => c.slug)).toContain('combat_cover');
      expect(warnings).toHaveLength(1);
    };

    it('when vectors are missing', async () => {
      await expectFallback(fixture(), {});
    });

    it('when vectors come from another model', async () => {
      const other = fixture();
      await embedChunks(other, { model: 'other-model', embed });
      await expectFallback(other, {});
    });

    it('when the embedder throws', async () => {
      const broken: Embedder = async () => {
        throw new Error('Ollama is not reachable');
      };
      await expectFallback(db, { embed: broken });
    });

    it('when the caller did not load sqlite-vec', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'dnd-rules-')), 'rules.db');
      await db.backup(path);
      const unloaded = new Database(path);
      await expectFallback(unloaded, {});
    });
  });

  it('does not throw on FTS syntax in the question', async () => {
    await expect(search('what\'s "prone" AND -* (x)?')).resolves.toMatchObject({ mode: 'hybrid' });
  });

  it('handles a question of only stop words', async () => {
    await expect(search('what is it?')).resolves.toMatchObject({ mode: 'hybrid' });
  });

  it('explains a rules.db without chunks', async () => {
    await expect(search('cover', {}, new Database(':memory:'))).rejects.toThrow(
      /run pnpm data:import/
    );
  });

  it('respects limit', async () => {
    expect((await search('cover', { limit: 2 })).chunks.length).toBeLessThanOrEqual(2);
    expect((await search('cover')).chunks.length).toBeLessThanOrEqual(5);
  });
});
