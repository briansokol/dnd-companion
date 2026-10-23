import { describe, expect, it, vi } from 'vitest';
import { fetchAll } from './open5e.js';

const BASE = 'https://open5e.test/v2';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const noSleep = async () => {};

describe('fetchAll', () => {
  it('follows next links until the last page', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === `${BASE}/spells/?document__key=srd-2024&limit=2`) {
        return json({ next: `${BASE}/spells/?page=2`, results: [{ key: 'a', name: 'A' }] });
      }
      return json({ next: null, results: [{ key: 'b', name: 'B' }] });
    });

    const records = await fetchAll('spells', { baseUrl: BASE, pageSize: 2, fetch, sleep: noSleep });

    expect(records.map((r) => r.key)).toEqual(['a', 'b']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries server errors, rate limits and network failures', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({}, 429))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({ next: null, results: [{ key: 'a', name: 'A' }] }));

    const records = await fetchAll('feats', { baseUrl: BASE, fetch, sleep: noSleep, retries: 3 });

    expect(records).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('gives up after the retry budget', async () => {
    const fetch = vi.fn(async () => json({}, 500));

    await expect(
      fetchAll('feats', { baseUrl: BASE, fetch, sleep: noSleep, retries: 2 })
    ).rejects.toThrow(/500/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry client errors', async () => {
    const fetch = vi.fn(async () => json({}, 404));

    await expect(fetchAll('nope', { baseUrl: BASE, fetch, sleep: noSleep })).rejects.toThrow(/404/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects pages that are not the expected shape', async () => {
    const fetch = vi.fn(async () => json({ next: null, results: [{ name: 'No key' }] }));

    await expect(fetchAll('feats', { baseUrl: BASE, fetch, sleep: noSleep })).rejects.toThrow(
      /feats/
    );
  });
});
