import { describe, expect, it } from 'vitest';
import { documentPrefix, ollamaEmbedder, queryPrefix } from './embed.js';

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
