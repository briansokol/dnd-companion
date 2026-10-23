import { z } from 'zod';

export const DOCUMENT_KEY = 'srd-2024';

const recordSchema = z.looseObject({ key: z.string(), name: z.string() });
const pageSchema = z.object({ next: z.string().nullable(), results: z.array(recordSchema) });

export type Open5eRecord = z.infer<typeof recordSchema>;

export interface FetchAllOptions {
  baseUrl: string;
  pageSize?: number;
  /** Extra attempts per page after the first. */
  retries?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Every `srd-2024` record from one Open5e v2 endpoint, following `next` links. */
export async function fetchAll(
  endpoint: string,
  options: FetchAllOptions
): Promise<Open5eRecord[]> {
  const records: Open5eRecord[] = [];
  let url: string | null =
    `${options.baseUrl}/${endpoint}/?document__key=${DOCUMENT_KEY}&limit=${options.pageSize ?? 500}`;
  while (url) {
    const result = pageSchema.safeParse(await fetchJson(url, options));
    if (!result.success) {
      throw new Error(
        `Unexpected Open5e response for ${endpoint} (${url}): ${result.error.message}`
      );
    }
    records.push(...result.data.results);
    url = result.data.next;
  }
  return records;
}

async function fetchJson(url: string, options: FetchAllOptions): Promise<unknown> {
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let error: unknown;
    try {
      // Open5e's CDN rejects some default user agents.
      res = await fetch(url, { headers: { 'user-agent': 'dnd-companion-importer' } });
    } catch (caught) {
      error = caught;
    }
    if (res?.ok) return res.json();
    if (res) {
      error = new Error(`Open5e ${res.status} for ${url}`);
      if (res.status !== 429 && res.status < 500) throw error;
    }
    if (attempt >= retries) throw error;
    await sleep(1000 * 2 ** attempt);
  }
}
