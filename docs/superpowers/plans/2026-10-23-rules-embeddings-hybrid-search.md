# Rules Embeddings and Hybrid Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chunk the rules text and conditions in `rules.db`, embed them through Ollama into sqlite-vec with a resumable `pnpm data:embed`, and add `searchRules()`, a hybrid FTS5 + vector search returning cited chunks, verified by a 12-question spot-check on the Mac.

**Architecture:** The import (no Ollama needed) writes `rules_chunks` and an FTS5 index over them. A separate embed step fills a `vec0` table, keyed by chunk id with an `audience` metadata column. `searchRules` runs both halves with the audience filter inside each query, merges them with reciprocal rank fusion, and falls back to FTS when vectors are unusable.

**Tech Stack:** TypeScript (strict), better-sqlite3 13, `sqlite-vec` 0.1.9 (npm, loaded with `sqliteVec.load(db)`), Ollama native `POST /api/embed`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-rules-embeddings-hybrid-search-design.md`

## Global Constraints

- No network in tests. Use the injected `Embedder` and the importer's recorded fixtures.
- No hard-coded hosts or models: `OLLAMA_BASE_URL`, `EMBED_MODEL` and `RULES_DB_PATH` come from `loadConfig()` (`@dnd/shared`).
- Ollama native API only: `POST {OLLAMA_BASE_URL}/api/embed` with body `{ model, input: string[] }`, response `{ embeddings: number[][] }`.
- `player` sees only `audience = 'player'`; `dm` sees `player` and `dm`, matching `searchNames`.
- Embed only `rules_sections` and `conditions`.
- nomic prefixes: documents `search_document: `, queries `search_query: `; no prefix for other models.
- RRF k = 60; each half takes its top 20; default `limit` 5.
- Chunk thresholds: merge pieces under 300 characters, split pieces over 1,500 at paragraph boundaries, never split inside one block (a list or a table).
- `sqlite-vec` is a production dependency of `@dnd/mcp`. `data:embed` and `data:spotcheck` run from the host through `tsx`, like `data:import`.
- Match the existing style: small modules, JSDoc one-liners, `db.prepare(...).all() as T[]`.

## Review Focus

1. **Questions with FTS5 syntax in them** (`what's "prone"?`, `AND`, `-`, `*`, parentheses) must not throw. The FTS half quotes each term. Test in Task 4.
2. **A question that is empty or only stop words** ("what is it?") returns an empty FTS half without throwing, and the vector half still runs. Test in Task 4.
3. **A `rules.db` built before this change** (no `rules_chunks`) makes `searchRules` throw an error that says to run `pnpm data:import`, not a raw SQLite "no such table". Test in Task 4.
4. **Model names with a tag** (`nomic-embed-text:latest`) still get the nomic prefixes. Test in Task 3.
5. **Re-running `data:embed` after a full run** makes no Ollama calls. Test in Task 3.

## File Structure

- `packages/mcp/src/search/chunks.ts`: `chunkMarkdown`, `citation`, `buildRulesChunks` (pure chunking plus writing the tables).
- `packages/mcp/src/search/chunks.test.ts`
- `packages/mcp/src/importer/importer.ts` (modify): call `buildRulesChunks(db)` before `buildNameIndex`.
- `packages/mcp/src/importer/importer.test.ts` (modify): chunk tables exist after import.
- `packages/mcp/src/embeddings/embed.ts`: `Embedder`, `ollamaEmbedder`, `documentPrefix`, `queryPrefix`, `loadVec`, `embedChunks`.
- `packages/mcp/src/embeddings/embed.test.ts`
- `packages/mcp/src/embeddings/main.ts`: the `data:embed` CLI.
- `packages/mcp/src/search/rules.ts`: `searchRules`.
- `packages/mcp/src/search/rules.test.ts`
- `packages/mcp/src/search/spotcheck.ts` + `packages/mcp/src/search/spotcheck-questions.json`: the `data:spotcheck` CLI.
- `packages/mcp/src/testing/rules-db.ts`: shared test helpers (`rulesDb`, `fakeEmbedder`). Excluded from the build.
- `packages/mcp/package.json`, root `package.json`, `packages/mcp/tsconfig.build.json`, `AGENTS.md` (modify).

---

### Task 1: Chunker and chunk tables written by the import

**Files:**
- Create: `packages/mcp/src/search/chunks.ts`, `packages/mcp/src/search/chunks.test.ts`, `packages/mcp/src/testing/rules-db.ts`
- Modify: `packages/mcp/src/importer/importer.ts` (around the `buildNameIndex(db, ...)` call), `packages/mcp/src/importer/importer.test.ts`, `packages/mcp/tsconfig.build.json` (add `"src/testing/**"` to `exclude`)

**Interfaces:**
- Produces:
  ```ts
  export interface Piece { heading: string; text: string }
  export function chunkMarkdown(markdown: string): Piece[]
  export function citation(c: { chapter: string; section: string; heading: string }): string
  /** Creates rules_chunks and rules_chunks_fts from the rules_sections and conditions tables. Returns the chunk count. */
  export function buildRulesChunks(db: Database.Database): number
  ```
  Table `rules_chunks(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, slug TEXT NOT NULL, chapter TEXT NOT NULL, section TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, audience TEXT NOT NULL, position INTEGER NOT NULL)`.
  `rules_chunks_fts`: `fts5(chapter, section, heading, text, content='rules_chunks', content_rowid='id', tokenize='porter unicode61')`, filled with `INSERT INTO rules_chunks_fts(rules_chunks_fts) VALUES ('rebuild')`.
  `src/testing/rules-db.ts`: `rulesDb(rows: { sections?: SectionRow[]; conditions?: ConditionRow[] }): Database.Database` builds an in-memory db holding `rules_sections` (`slug, name, source, audience, ruleset, position, raw_json`) and `conditions` (`slug, name, source, audience, raw_json`) with `raw_json = JSON.stringify({ desc })`, then calls `buildRulesChunks`. Here `SectionRow = { slug, name, ruleset, position, audience, desc }` and `ConditionRow = { slug, name, audience?, desc }`.

**Chunking algorithm** (the tests pin it):
1. Split on blank lines into blocks. A block whose first line is `## X` or `### Y` sets the heading path (`X`, or `X › Y` under the most recent `##`; a `##` resets it) and its remaining lines, if any, start the next piece. Otherwise the block joins the current piece. Strip the heading line from the text.
2. A piece shorter than 300 characters merges into the **next** piece if that piece's heading path starts with its own (a parent intro before its subsections, which keeps the parent heading). Otherwise it merges into the **previous** piece (keeping the previous heading). If it's the only piece, it stays.
3. A piece over 1,500 characters splits at block boundaries into runs of at most 1,500. A single block over 1,500 stays whole. Each run keeps the heading.

`citation` joins `chapter`, `section` and `heading` with ` › `, skipping empty parts and any part equal to the one before it. Chapter for a rules section is the `name` of the `rules_sections` row with the same `ruleset` and `position = 0`. Conditions get `chapter = 'Conditions'`, `section = name`, `heading = ''`, and one chunk each. `position` is the chunk's order within its parent.

- [ ] **Step 1: Write failing tests in `chunks.test.ts`**

```ts
describe('chunkMarkdown', () => {
  it('splits on ## and ### and keeps the heading path', () => {
    const md = `Intro ${'a'.repeat(400)}\n\n## Initiative\n\n${'b'.repeat(400)}\n\n### Surprise\n\n${'c'.repeat(400)}\n\n## Your Turn\n\n${'d'.repeat(400)}`;
    expect(chunkMarkdown(md).map((p) => p.heading)).toEqual(['', 'Initiative', 'Initiative › Surprise', 'Your Turn']);
  });
  it('merges a short parent intro into its first subsection under the parent heading', () => {
    const md = `## Cover\n\nShort intro.\n\n### Half Cover\n\n${'h'.repeat(400)}`;
    expect(chunkMarkdown(md)).toEqual([{ heading: 'Cover', text: `Short intro.\n\n${'h'.repeat(400)}` }]);
  });
  it('merges a short trailing piece into the previous one', () => {
    const md = `## A\n\n${'a'.repeat(400)}\n\n## B\n\nTiny.`;
    expect(chunkMarkdown(md)).toEqual([{ heading: 'A', text: `${'a'.repeat(400)}\n\nTiny.` }]);
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
    const table = ['|1d100|Trinket|', '|---|---|', ...Array.from({ length: 100 }, (_, i) => `|${i}|${'x'.repeat(30)}|`)].join('\n');
    expect(chunkMarkdown(table)).toEqual([{ heading: '', text: table }]);
  });
});

describe('citation', () => {
  it('joins chapter, section and heading and skips empty or repeated parts', () => {
    expect(citation({ chapter: 'Combat', section: 'The Order of Combat', heading: 'Initiative' })).toBe('Combat › The Order of Combat › Initiative');
    expect(citation({ chapter: 'Combat', section: 'Combat', heading: '' })).toBe('Combat');
    expect(citation({ chapter: 'Conditions', section: 'Prone', heading: '' })).toBe('Conditions › Prone');
  });
});

describe('buildRulesChunks', () => {
  // rulesDb() from src/testing/rules-db.ts: a `combat` intro row (position 0), `combat_cover` (player),
  // a dm-only `secret_rules` row in ruleset `secret`, and conditions `prone` and `grappled`.
  it('writes one row per piece with chapter, section, audience and source from the parent');
  // asserts combat_cover → chapter 'Combat', section 'Cover', audience 'player', source 'srd-2024';
  // secret_rules → audience 'dm'; prone → kind 'conditions', chapter 'Conditions', section 'Prone', heading ''.
  it('indexes chunks in FTS with stemming');
  // SELECT slug FROM rules_chunks_fts JOIN rules_chunks ON rules_chunks.id = rules_chunks_fts.rowid WHERE rules_chunks_fts MATCH 'grappling' → includes 'grappled'
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @dnd/mcp exec vitest run src/search/chunks.test.ts` → module not found.
- [ ] **Step 3: Implement `chunks.ts` and `src/testing/rules-db.ts`** as specified above, and add `"src/testing/**"` to `tsconfig.build.json` `exclude`.
- [ ] **Step 4: Run, expect PASS** (same command).
- [ ] **Step 5: Wire into the importer.** Call `buildRulesChunks(db)` right before `buildNameIndex(db, Object.keys(counts))`. Add a test to `importer.test.ts`, `it('writes rules chunks for every rules section and condition')`: after `runImport(options({ dbPath }))`, `SELECT COUNT(DISTINCT slug) FROM rules_chunks WHERE kind = 'rules_sections'` equals 4 and `... WHERE kind = 'conditions'` equals 15. Run `pnpm --filter @dnd/mcp test` → all PASS.
- [ ] **Step 6: Commit** — `git add packages/mcp && git commit -m "Chunk rules sections and conditions into rules_chunks with FTS"` (with the `Refs #7` line and the Co-Authored-By trailer).

---

### Task 2: sqlite-vec dependency and embedder

**Files:**
- Create: `packages/mcp/src/embeddings/embed.ts` (first half), `packages/mcp/src/embeddings/embed.test.ts`
- Modify: `packages/mcp/package.json` (via `pnpm --filter @dnd/mcp add sqlite-vec@^0.1.9`), `pnpm-workspace.yaml` (`allowBuilds` only if pnpm reports an ignored build script for sqlite-vec), `pnpm-lock.yaml`

**Interfaces:**
- Produces:
  ```ts
  export type Embedder = (texts: string[]) => Promise<number[][]>;
  export function ollamaEmbedder(options: { baseUrl: string; model: string; fetch?: typeof fetch }): Embedder
  export function documentPrefix(model: string): string // 'search_document: ' for nomic-embed-text[:tag], else ''
  export function queryPrefix(model: string): string    // 'search_query: '   for nomic-embed-text[:tag], else ''
  export function loadVec(db: Database.Database): void   // sqliteVec.load(db)
  ```
  `ollamaEmbedder` errors: a fetch rejection → `Error('Ollama is not reachable at {baseUrl}')`; a 404 → `Error('Embedding model "{model}" is not pulled. Run: ollama pull {model}')`; any other non-OK → `Error('Ollama embed failed: {status} {body}')`.

- [ ] **Step 1: Add the dependency** and check it loads: `pnpm --filter @dnd/mcp add sqlite-vec@^0.1.9`, then `pnpm --filter @dnd/mcp exec node -e "const d=new (require('better-sqlite3'))(':memory:');require('sqlite-vec').load(d);console.log(d.prepare('select vec_version() v').get())"` → `{ v: 'v0.1.9' }`.
- [ ] **Step 2: Write failing tests** in `embed.test.ts`:
  - `ollamaEmbedder` posts `{ model: 'nomic-embed-text', input: ['a', 'b'] }` to `http://ollama:11434/api/embed` and returns `embeddings` (using a stub `fetch` that records the request).
  - It throws `/not reachable at http:\/\/ollama:11434/` when fetch rejects, and `/ollama pull nomic-embed-text/` on a 404.
  - `documentPrefix('nomic-embed-text')` and `documentPrefix('nomic-embed-text:latest')` are `'search_document: '`; `queryPrefix('nomic-embed-text:v1.5')` is `'search_query: '`; `documentPrefix('mxbai-embed-large')` is `''`.
- [ ] **Step 3: Run, expect FAIL** — `pnpm --filter @dnd/mcp exec vitest run src/embeddings/embed.test.ts`.
- [ ] **Step 4: Implement.** Prefixes come from a map keyed by the model name with any `:tag` removed.
- [ ] **Step 5: Run, expect PASS.**
- [ ] **Step 6: Commit** — "Add sqlite-vec and an Ollama embedder".

---

### Task 3: `embedChunks` and `pnpm data:embed`

**Files:**
- Modify: `packages/mcp/src/embeddings/embed.ts`, `packages/mcp/src/embeddings/embed.test.ts`, `packages/mcp/src/testing/rules-db.ts`
- Create: `packages/mcp/src/embeddings/main.ts`
- Modify: `packages/mcp/package.json` (`"data:embed": "tsx src/embeddings/main.ts"`), root `package.json` (`"data:embed": "pnpm --filter @dnd/shared build && pnpm --filter @dnd/mcp data:embed"`)

**Interfaces:**
- Consumes: `Embedder`, `documentPrefix`, `loadVec` (Task 2); `rules_chunks`, `citation` (Task 1).
- Produces:
  ```ts
  export interface EmbedOptions { model: string; embed: Embedder; batchSize?: number /* 32 */; onProgress?: (done: number, total: number) => void }
  /** Embeds chunks missing from rules_vec. Rebuilds rules_vec when import_meta.embed_model differs from model. */
  export async function embedChunks(db: Database.Database, options: EmbedOptions): Promise<{ embedded: number; total: number }>
  ```
  The caller loads sqlite-vec first. Table: `CREATE VIRTUAL TABLE rules_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[{dims}] distance_metric=cosine, audience TEXT)`. `chunk_id` binds as a BigInt. Vectors bind as `Float32Array`. `import_meta` rows `embed_model` and `embed_dims` are upserted when the table is created (`INSERT ... ON CONFLICT(key) DO UPDATE`).
  `src/testing/rules-db.ts` gains `fakeEmbedder(vocab: string[]): Embedder & { calls: string[][] }`, a bag-of-words vector over `vocab` (lowercased substring counts plus a constant 0.01 component so no vector is all zero), recording each call's texts.

Flow: if the stored model differs, drop `rules_vec` and its meta rows. Select chunks with no `rules_vec` row (`WHERE id NOT IN (SELECT chunk_id FROM rules_vec)`, or every chunk if the table doesn't exist yet). For each batch, embed `documentPrefix(model) + citation(chunk) + '\n\n' + text`, create the table on the first batch using the returned dims, insert the batch in one transaction, then call `onProgress`.

- [ ] **Step 1: Write failing tests** (`describe('embedChunks')`, a `rulesDb()` with `loadVec`):
  - `it('embeds every chunk with the document prefix and citation')`: `embedded` equals the chunk count; the first text sent starts with `'search_document: Combat'`; `rules_vec` row count equals the `rules_chunks` count; `import_meta.embed_model` is `'nomic-embed-text'`.
  - `it('resumes after an interrupted run')`: an embedder that throws on its 2nd call with `batchSize: 1` rejects; a second run with a working fake embeds only `total - 1` chunks.
  - `it('makes no embed calls when everything is embedded')` (Review Focus 5): second run → `embedded: 0`, `fake.calls.length === 0`.
  - `it('rebuilds when the model changes')`: run with `'nomic-embed-text'`, then with `'other-model'` → `embedded === total` and `embed_model` is `'other-model'`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `embedChunks`.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Write `main.ts`**, modeled on `importer/main.ts`: load the config, open `RULES_DB_PATH` (fail with "run pnpm data:import first" if the file or `rules_chunks` is missing), `loadVec`, run `embedChunks` with `ollamaEmbedder({ baseUrl: OLLAMA_BASE_URL, model: EMBED_MODEL })`, print progress on one line, and finish with `Embedded {embedded} of {total} chunks with {model}`. Errors print their message and exit 1. Add both `data:embed` scripts.
- [ ] **Step 6: Verify on this Mac** — `pnpm data:import && pnpm data:embed` → a full run completes. Run `pnpm data:embed` again → `Embedded 0 of N`. Stop Ollama briefly or set `OLLAMA_BASE_URL=http://localhost:1` and confirm the "not reachable" message and exit code 1.
- [ ] **Step 7: Commit** — "Add resumable data:embed into sqlite-vec".

---

### Task 4: `searchRules` hybrid search

**Files:**
- Create: `packages/mcp/src/search/rules.ts`, `packages/mcp/src/search/rules.test.ts`

**Interfaces:**
- Consumes: `Embedder`, `queryPrefix` (Task 2); `rules_vec`, `import_meta.embed_model`, `embedChunks` (Task 3, used by the tests); `rulesDb`, `fakeEmbedder` (testing helpers).
- Produces:
  ```ts
  export interface RuleChunk { kind: 'rules_sections' | 'conditions'; slug: string; chapter: string; section: string; heading: string; source: string; text: string; score: number }
  export interface RulesSearchResult { mode: 'hybrid' | 'fts'; chunks: RuleChunk[] }
  export interface RulesSearchOptions { audience: Audience; model: string; embed: Embedder; limit?: number /* 5 */; warn?: (message: string) => void /* console.warn */ }
  /** Hybrid FTS + vector search over rules_chunks. The caller loads sqlite-vec. */
  export async function searchRules(db: Database.Database, question: string, options: RulesSearchOptions): Promise<RulesSearchResult>
  ```

Behavior:
- No `rules_chunks` table → throw `Error('rules.db has no rules_chunks; run pnpm data:import')`.
- FTS half: lowercase, take `\p{L}[\p{L}\p{N}']*` words, strip apostrophes, drop a short stop-word list (the builder writes it; it must include `what is a the do does i can how my when`), quote each term and join with ` OR `. Run `ORDER BY bm25(rules_chunks_fts)` with the audience filter, `LIMIT 20`. No terms → empty half.
- Vector half: only when `rules_vec` exists, has rows and `import_meta.embed_model === model`. Embed `queryPrefix(model) + question`, then KNN with `embedding MATCH ? AND k = 20 AND audience IN (...)`. If unusable, or the embedder throws, `warn(...)` and use `mode: 'fts'`.
- Merge: `score = Σ 1 / (60 + rank)` (rank starting at 1) across the halves. Sort by score descending, then by FTS rank (missing ranks last). Take `limit`.

- [ ] **Step 1: Write failing tests.** The fixture is a `rulesDb` with sections `combat_cover` ("Cover" — text about walls and half cover), `exploration_hazards` ("Hazards" — text about burning and fire), a dm-only `secret_rules` whose text mentions cover, fire and walls as often as possible (the best match for both halves), and conditions `prone`/`grappled`. Use `fakeEmbedder(['cover', 'wall', 'fire', 'burn', 'prone', 'grappl'])` plus `embedChunks`.
  - `it('finds a chunk the FTS half misses')`: query `'aflameburn'`. FTS matches nothing (no such token), but the fake's substring vocab gives it a `burn` component, so vectors find `exploration_hazards` → it is first and `mode === 'hybrid'`.
  - `it('ranks a chunk found by both halves above one found by either')`: query `'cover behind a wall'` → `combat_cover` is first.
  - `it('never returns dm chunks to players from either half')`: query `'cover fire wall'` with `audience: 'player'` → no `secret_rules`; with `audience: 'dm'` → `secret_rules` is first.
  - `it('returns citation fields')`: first chunk has `chapter`, `section`, `heading`, `source: 'srd-2024'`, `kind`, `slug`.
  - `it('falls back to FTS when vectors are missing, from another model, or the embedder throws')`: three cases each give `mode: 'fts'` with `combat_cover` found for `'cover'`, and `warn` called once.
  - `it('does not throw on FTS syntax in the question')` (Review Focus 1): `'what\'s "prone" AND -* (x)?'` resolves.
  - `it('handles a question of only stop words')` (Review Focus 2): `'what is it?'` resolves with `mode: 'hybrid'`.
  - `it('explains a rules.db without chunks')` (Review Focus 3): a bare in-memory db rejects with `/run pnpm data:import/`.
  - `it('respects limit')`: `limit: 2` → at most 2 chunks.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @dnd/mcp exec vitest run src/search/rules.test.ts`.
- [ ] **Step 3: Implement `searchRules`.**
- [ ] **Step 4: Run, expect PASS**, then `pnpm test && pnpm typecheck && pnpm lint` → all pass.
- [ ] **Step 5: Commit** — "Add hybrid rules search with RRF and FTS fallback".

---

### Task 5: Spot-check on real data, Docker check, docs

**Files:**
- Create: `packages/mcp/src/search/spotcheck.ts`, `packages/mcp/src/search/spotcheck-questions.json`
- Modify: `packages/mcp/package.json` (`"data:spotcheck": "tsx src/search/spotcheck.ts"`), root `package.json` (`"data:spotcheck": "pnpm --filter @dnd/shared build && pnpm --filter @dnd/mcp data:spotcheck"`), `AGENTS.md` (Commands: `pnpm data:embed`, `pnpm data:spotcheck`; note that `data:embed` follows every `data:import`), `packages/mcp/src/importer/main.ts` (one closing line: `Next: pnpm data:embed`)

**Interfaces:**
- Consumes: `searchRules`, `ollamaEmbedder`, `loadVec`, `citation`.
- `spotcheck-questions.json`: `[{ "question": string, "expected": string[] }]`, where each expected entry is `"{kind}:{slug}"`, e.g. `"rules_sections:combat_cover"` or `"conditions:prone"`. It holds the 12 questions and expected slugs from the spec's table, verbatim.

- [ ] **Step 1: Write `spotcheck.ts`**: load the config, open `RULES_DB_PATH` read-only, `loadVec`, and for each question run `searchRules(..., { audience: 'player', model: EMBED_MODEL, embed: ollamaEmbedder(...), limit: 3 })`. Print `PASS`/`FAIL`, the question, and the top 3 as `citation (kind:slug)`. Print a final `{passed}/{total} passed` and exit 1 if any failed, or if `mode` was `'fts'` (vectors not built).
- [ ] **Step 2: Run on this Mac** — `pnpm data:spotcheck`. Expected: `12/12 passed`. While any question fails, tune in this order: the stop words, the embedded-text format, then the chunk thresholds (re-running `pnpm data:import && pnpm data:embed` after threshold changes, and keeping Task 1's tests in line with the new values). Do not widen any `expected`. If a question can't pass because its answer isn't in the data, move it to #57 with an issue comment (ask the user before posting) and remove it from the JSON.
- [ ] **Step 3: Docker check** — `docker buildx build --platform linux/amd64 --target mcp -t dnd-mcp:vec-check --load .`, then `docker run --rm --platform linux/amd64 --entrypoint node dnd-mcp:vec-check -e "const d=new (require('better-sqlite3'))(':memory:');require('sqlite-vec').load(d);console.log(d.prepare('select vec_version() v').get())"` (run from the image's working directory) → `{ v: 'v0.1.9' }`. If Docker isn't available, say so in the PR and leave this to the Firefly test.
- [ ] **Step 4: Update `AGENTS.md`** and the importer's closing hint. Run `pnpm lint && pnpm typecheck && pnpm test` → all pass.
- [ ] **Step 5: Commit** — "Add rules search spot-check and document data:embed". The PR body says `Closes #7`, includes the spot-check output, and notes that Firefly verification is pending (#21).
