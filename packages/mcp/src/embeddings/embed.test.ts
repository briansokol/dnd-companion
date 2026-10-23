import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { fakeEmbedder, rulesDb } from '../testing/rules-db.js';
import {
  documentPrefix,
  embedChunks,
  loadVec,
  ollamaEmbedder,
  queryPrefix,
  type Embedder
} from './embed.js';

describe('ollamaEmbedder', () => {
  it('posts the model and inputs to /api/embed and returns the embeddings', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          embeddings: [
            [1, 2],
            [3, 4]
          ]
        })
      );
    };
    const embed = ollamaEmbedder({
      baseUrl: 'http://ollama:11434',
      model: 'nomic-embed-text',
      fetch
    });

    expect(await embed(['a', 'b'])).toEqual([
      [1, 2],
      [3, 4]
    ]);
    expect(requests).toEqual([
      {
        url: 'http://ollama:11434/api/embed',
        body: { model: 'nomic-embed-text', input: ['a', 'b'] }
      }
    ]);
  });

  it('says when Ollama is not reachable', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const embed = ollamaEmbedder({
      baseUrl: 'http://ollama:11434',
      model: 'nomic-embed-text',
      fetch
    });
    await expect(embed(['a'])).rejects.toThrow(/not reachable at http:\/\/ollama:11434/);
  });

  it('says how to pull a missing model', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response('{"error":"model not found"}', { status: 404 });
    const embed = ollamaEmbedder({
      baseUrl: 'http://ollama:11434',
      model: 'nomic-embed-text',
      fetch
    });
    await expect(embed(['a'])).rejects.toThrow(/ollama pull nomic-embed-text/);
  });
});

describe('prefixes', () => {
  it('uses the nomic task prefixes for nomic-embed-text with or without a tag', () => {
    expect(documentPrefix('nomic-embed-text')).toBe('search_document: ');
    expect(documentPrefix('nomic-embed-text:latest')).toBe('search_document: ');
    expect(queryPrefix('nomic-embed-text:v1.5')).toBe('search_query: ');
  });

  it('uses no prefix for other models', () => {
    expect(documentPrefix('mxbai-embed-large')).toBe('');
    expect(queryPrefix('mxbai-embed-large')).toBe('');
  });
});

describe('embedChunks', () => {
  const VOCAB = ['cover', 'wall', 'prone'];
  const fixture = () => {
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
        }
      ],
      conditions: [{ slug: 'prone', name: 'Prone', desc: 'You are on the ground.' }]
    });
    loadVec(db);
    return db;
  };
  const count = (db: Database.Database, table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const meta = (db: Database.Database, key: string) =>
    (
      db.prepare('SELECT value FROM import_meta WHERE key = ?').get(key) as
        { value: string } | undefined
    )?.value;

  it('embeds every chunk with the document prefix and citation', async () => {
    const db = fixture();
    const embed = fakeEmbedder(VOCAB);

    const result = await embedChunks(db, { model: 'nomic-embed-text', embed });

    expect(result).toEqual({ embedded: 3, total: 3 });
    expect(embed.calls[0]![0]).toBe('search_document: Combat\n\nCombat intro.');
    expect(count(db, 'rules_vec')).toBe(count(db, 'rules_chunks'));
    expect(meta(db, 'embed_model')).toBe('nomic-embed-text');
    expect(meta(db, 'embed_dims')).toBe('4');
  });

  it('resumes after an interrupted run', async () => {
    const db = fixture();
    const working = fakeEmbedder(VOCAB);
    let calls = 0;
    const flaky: Embedder = async (texts) => {
      if (++calls === 2) throw new Error('Ollama went away');
      return working(texts);
    };
    await expect(
      embedChunks(db, { model: 'nomic-embed-text', embed: flaky, batchSize: 1 })
    ).rejects.toThrow('Ollama went away');

    const result = await embedChunks(db, { model: 'nomic-embed-text', embed: fakeEmbedder(VOCAB) });
    expect(result).toEqual({ embedded: 2, total: 3 });
    expect(count(db, 'rules_vec')).toBe(3);
  });

  it('makes no embed calls when everything is embedded', async () => {
    const db = fixture();
    await embedChunks(db, { model: 'nomic-embed-text', embed: fakeEmbedder(VOCAB) });
    const embed = fakeEmbedder(VOCAB);

    expect(await embedChunks(db, { model: 'nomic-embed-text', embed })).toEqual({
      embedded: 0,
      total: 3
    });
    expect(embed.calls).toHaveLength(0);
  });

  it('rebuilds when the model changes', async () => {
    const db = fixture();
    await embedChunks(db, { model: 'nomic-embed-text', embed: fakeEmbedder(VOCAB) });

    const result = await embedChunks(db, { model: 'other-model', embed: fakeEmbedder(VOCAB) });
    expect(result).toEqual({ embedded: 3, total: 3 });
    expect(count(db, 'rules_vec')).toBe(3);
    expect(meta(db, 'embed_model')).toBe('other-model');
  });
});
