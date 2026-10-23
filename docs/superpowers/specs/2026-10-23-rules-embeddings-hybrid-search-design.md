# Rules embeddings and hybrid search (issue #7)

## Intent

At the table, the DM asks how the game works: "what does having advantage mean?", "can I grapple while prone?". Those questions rarely use the rules' own words, so name search (#56) can't answer them. This issue chunks the rules text, embeds it with the local embedding model, and adds a hybrid search that merges keyword (FTS5) and meaning (sqlite-vec) matches, returning cited chunks. The `search_rules` MCP tool (#10) wraps it later.

Success: a fixed set of about 10 table-style questions each returns a relevant chunk in the top 3, run against the real `rules.db` and Ollama on the Mac.

## Goals

- Chunk `rules_sections` and `conditions` into citable pieces, written to `rules.db` by the import.
- `pnpm data:embed`: a separate, resumable step that embeds chunks through Ollama (`EMBED_MODEL`, default `nomic-embed-text`) into a sqlite-vec table.
- `searchRules()` in `packages/mcp/src/search/`: hybrid FTS + vector search returning the top-k chunks, each with section title, heading path and source for citation.
- The audience filter is applied inside both the FTS query and the vector query, before the merge.
- A spot-check script that runs the question set against the local `rules.db` and live Ollama.

## Non-goals

- **Spells, items, creatures, magic items, classes and the rest are not embedded.** Questions that name a specific thing ("do I roll to hit with Magic Missile?", "what's a dagger's damage?") go through the name lookup (#9). The user confirmed this.
- **The Rules Glossary.** Open5e's srd-2024 rules leave it out, so Burning, Concentration, Grapple and the spellcasting rules are not in `rules.db`. That is #57, which comes after this issue and adds "on fire" to the spot-check set.
- **The MCP tool, the token budget and result cards.** Those are #10 and #14.
- **Deploy wiring.** Running import + embed on Firefly belongs to #21. This issue only has to make sure the command works against a configured `OLLAMA_BASE_URL`. It gets verified on the Mac now, and the user tests Firefly later.

## Anti-goals

- Search that fails outright when vectors are missing or Ollama is down. It falls back to FTS only.
- Player-audience results containing `dm` rows, from either half.
- Tests that hit the network.

## Constraints

- Local only: Ollama's native API (`POST /api/embed`, batched `input`). No cloud calls.
- `dnd-mcp` is the only process that opens `rules.db`. The search code lives in `packages/mcp`.
- No hard-coded hosts or model names. Use `OLLAMA_BASE_URL` and `EMBED_MODEL` from `@dnd/shared` config.
- TDD for the chunker, the merge and the audience filter, using a fake deterministic embedder.
- `searchRules` must load sqlite-vec in the `mcp` Docker image on Linux x64 as well as on macOS arm64, so `sqlite-vec` is a production dependency. `data:embed` runs from the host through `tsx` like `data:import`. Running it inside a container belongs to #21. *Call.*

## Decided with the user

- Name-specific questions go through the name lookup, not rules search.
- Embedding is a step that follows the import. It is not wired into the deploy script in this issue (#21 does that).
- The Rules Glossary seed is a separate issue (#57), extracted once from the SRD 5.2 PDF into a committed seed file.
- Verify on this Mac. The user verifies Firefly later.

## Design (calls I made, marked *call*)

### Data in `rules.db`

- **`rules_chunks`** (written by `data:import`): `id INTEGER PRIMARY KEY`, `kind` (`rules_sections` | `conditions`), `slug` (the parent row), `chapter` (the name of the ruleset's position-0 row, e.g. "Combat"; "Conditions" for conditions), `section` (the parent row's name, e.g. "The Order of Combat"; the condition name for conditions), `heading` (the `##`/`###` path within the row, e.g. "Initiative", empty for text before the first heading), `text`, `source`, `audience` (copied from the parent row), `position`. A citation reads `chapter › section › heading`, skipping empty or repeated parts (the `combat` row itself is "Combat", not "Combat › Combat"). *Call.*
- **`rules_chunks_fts`**: FTS5 over `chapter`, `section`, `heading` and `text`, external content on `rules_chunks`, with the `porter unicode61` tokenizer so "grappling" matches "grapple". *Call.*
- **`rules_vec`** (written by `data:embed`): a sqlite-vec `vec0` table with `chunk_id`, `embedding float[N]` and an `audience` metadata column so the KNN query filters on audience. N comes from the model's first response.
- **`import_meta`** gains `embed_model` and `embed_dims` once embedding has run.

Because the import rebuilds `rules.db` from scratch, a re-import drops the vectors and `data:embed` must run again. With a few hundred chunks that takes well under a minute. *Call:* don't carry vectors across imports.

### Chunking (*call*, sizes tuned against the spot-check)

- A rules section's `desc` is Markdown. Split it on `##`/`###` headings and keep the heading path.
- Merge adjacent pieces under about 300 characters into their neighbor. Split pieces over about 1,500 characters at paragraph boundaries. Never split inside a list or table.
- Each condition is one chunk.
- The embedded text is the citation, a blank line, then the text (`"Combat › The Order of Combat › Initiative\n\n…"`), so the titles add meaning. The stored `text` stays clean for display.

### `pnpm data:embed`

- `packages/mcp/src/embeddings/main.ts`, with a `data:embed` script in the root and in `@dnd/mcp`.
- Loads the sqlite-vec extension through the `sqlite-vec` npm package (`sqliteVec.load(db)`).
- If `import_meta.embed_model` differs from `EMBED_MODEL`, drop and recreate `rules_vec`.
- Embeds chunks that have no row in `rules_vec`, in batches of about 32, committing each batch. An interrupted run resumes from the missing rows, and a complete run is a no-op.
- nomic-embed-text expects task prefixes: documents get `search_document: ` and queries get `search_query: `. *Call:* keep the prefixes in one small map keyed by model name, with no prefix for unknown models.
- Prints progress, and fails clearly if Ollama is unreachable or the model isn't pulled (with a hint to `ollama pull`).

### `searchRules(db, question, options)`

- Options: `audience` (`player` sees only `player` rows; `dm` sees both, as in `searchNames`), `limit` (default 5), and `embed`, an injected `(texts) => Promise<number[][]>` so tests pass a fake.
- **FTS half:** tokenize the question, drop a short stop-word list, OR the remaining terms, rank by bm25, filter on audience, take the top 20.
- **Vector half:** embed the question, run a KNN query on `rules_vec` with `audience` in the `WHERE`, take the top 20.
- **Merge:** reciprocal rank fusion (k = 60) over chunk ids. Ties go to the FTS rank. *Call:* RRF because bm25 scores and cosine distances aren't comparable.
- **Result:** `{ mode: 'hybrid' | 'fts', chunks: [{ kind, slug, chapter, section, heading, source, text, score }] }`.
- `searchRules` is also given the configured `EMBED_MODEL` so it can detect a mismatch with `import_meta.embed_model`.
- **Fallback:** if `rules_vec` is missing, empty or built with a different model than `EMBED_MODEL`, or the query embedding throws, return FTS-only results with `mode: 'fts'` and log a warning.

### Spot-check

`pnpm data:spotcheck` (*call:* a script, not a Vitest test, because it needs the git-ignored `rules.db` and live Ollama). It runs each question with `audience: 'player'`, prints the top 3 with citations, marks each question pass or fail by whether an expected slug is in the top 3, and exits non-zero on any failure. The questions live in a committed JSON file next to the script.

Starting set (expected slugs; the builder confirms each against the data and adjusts expectations, not questions):

| Question | Expected (any of) |
|---|---|
| What does having advantage mean? | `d20-tests_advantage-disadvantage` |
| Can I grapple while prone? | conditions `prone`, `grappled` |
| How does cover work? | `combat_cover` |
| What happens when I drop to 0 hit points? | `damage-and-healing_dropping-to-zero-hit-points` |
| Do critical hits double the damage? | `damage-and-healing_critical-hits` |
| Can I attack something I can't see? | `combat_unseen-attackers-and-target`, condition `blinded` |
| When do I get an opportunity attack? | `combat_melee-attacks` |
| Do temporary hit points stack? | `damage-and-healing_temporary-hit-points` |
| Is it harder to shoot at someone right next to me? | `combat_ranged-attacks` |
| What if I'm resistant and vulnerable to the same damage? | `damage-and-healing_resistance-and-vulnerability` |
| What does being frightened do? | condition `frightened` |
| How far can we travel in a day? | `exploration_travel` |

"How often does a character take damage when on fire?" is added by #57.

**Done means every question passes.** A relevant chunk is one listed under Expected. For "can I grapple while prone?", the Prone or Grappled condition counts, since the full grapple rules arrive with #57. If tuning (chunk sizes, stop words, embedded-text format) can't make a question pass because the answer isn't in the current data, move that question to #57 with a note on the issue. Don't widen its expectations to loosely related slugs. *Call.*

### Tests (Vitest, no network)

- Chunker: heading splits, merging small pieces, splitting long ones, heading paths, lists and tables kept whole.
- Embed step: a fake embedder writes vectors; an interrupted run (embedder throws mid-way) resumes with only the missing chunks; a model change rebuilds.
- Search: RRF ordering; `player` never sees `dm` chunks from either half (the fixture has a `dm` chunk that is the best match for both FTS and vectors); FTS fallback when vectors are missing, built with another model, or the embedder throws.
- Uses the existing importer fixture plus a small set of hand-made chunks and vectors.

## Left to the builder

- Exact chunk thresholds, the stop-word list, and the batch size.
- Module layout inside `packages/mcp/src/`.
- Checking that `sqlite-vec`'s prebuilt Linux x64 binary resolves in the `mcp` Docker image (a quick `docker compose build` plus loading it in a container), and adding it to `allowBuilds` if pnpm requires it.
- Whether `pnpm data:import` prints a hint to run `pnpm data:embed` afterward.
- Updating `AGENTS.md` (commands) and `.env.example` if anything new is added.
