# D&D Companion — Architecture

Oct 22, 2026 · @Brian Sokol

## Overview

A LAN-served web app on Firefly that answers rules and stat questions at the table, and in phase 2 tracks party and combat state from plain-language DM updates. It runs on a local model through Ollama by default, with OpenAI as an optional fallback, and needs only about 16–24k tokens of context per turn, so a 32k window is plenty.

Design principles:

- **The model interprets; code computes.** The LLM turns "the ogre crits Thorin for 18" into `apply_damage("Thorin", 18, "bludgeoning")`. HP, resistances, concentration and death saves are deterministic code. The model never holds game state in its head.
- **State lives in the database, not the context window.** Each turn rebuilds a compact prompt from the DB, so session length never grows the context.
- **Retrieve, don't memorize.** Rules come from an SRD database via tools, so a small local model answers as accurately as a frontier one.
- **One tool surface, many clients.** Game tools sit in an MCP server, so the web app, Hermes Agent and Claude Desktop can all use them.
- **Every mutation is an event.** Changes are logged and undoable; the DM is the final authority.

## Architecture

&#91;embedded content: Firefly architecture · clients, app server, MCP server, data\]

The browser talks only to the SvelteKit app server, which runs the agent loop and routes model calls to Ollama or OpenAI. All rules and game state sit behind `dnd-mcp`, so Hermes or Claude Desktop can use the same tools without touching the web app.

## Model strategy

Context size is not the constraint; tool-calling reliability is. Because state and rules are fetched per turn, a 32k window covers every turn, and a smaller `num_ctx` also frees VRAM on the 3090 that a 160k KV cache would eat.

### Context budget per turn

| Slot | Est. tokens | Notes |
| --- | --- | --- |
| System prompt + tool schemas | 3–5k | \~15 tools, terse descriptions |
| Party + combat snapshot | 1–3k | Compact JSON: name, HP, AC, conditions, slots |
| Retrieved rules / stat blocks | 2–6k | Top 3–5 chunks, or one full stat block |
| Rolling conversation | 4–8k | Last \~10 turns; older turns summarized |
| Headroom for output + tool loops | 4k |  |
| **Total** | **\~16–24k** | Set `num_ctx` to 32k |

### Provider abstraction

Ollama exposes an OpenAI-compatible API, so the app uses one OpenAI-style client with two base URLs: Ollama on Firefly (default) and api.openai.com (fallback). Route per task, not per session: lookups and state updates stay local; optional "flavor" tasks (NPC dialogue, recap narration) can go to OpenAI if quality matters. A ChatGPT subscription does not include API access, so the fallback needs a separate pay-as-you-go API key.

### Local model shortlist

| Model | Why consider it | Watch for |
| --- | --- | --- |
| Your current Qwen model | Already loaded for Hermes, so no model swap or VRAM contention | Thinking mode adds latency; disable it for state updates |
| [gemma4:26b](https://computingforgeeks.com/?p=167394) | 26B-A4B MoE, fast on 24GB, native tool calling and vision | Second model resident alongside Hermes' |
| [mistral-small3.2:24b](https://computingforgeeks.com/?p=167394) | Strong native function calling and JSON output | Dense, slower than an A4B MoE |
| nomic-embed-text | Embeddings for rules search | Tiny; can stay resident |

Pick by evaluation, not benchmarks: script \~30 DM utterances with the expected tool calls (damage, healing, conditions, rule questions, ambiguous names) and choose the model with the best pass rate at acceptable latency (target under 2 seconds to first tool call).

## Data layer

Two SQLite databases: a read-only rules DB rebuilt from Open5e, and a game-state DB that is the source of truth for every campaign. SQLite keeps it a single file to back up to the NAS; swap to Postgres only if multiple tables play at once.

### Rules DB (`rules.db`)

- **Import:** a script pulls Open5e v2 (`srd-2024`) and v1 (`wotc-srd`, 2014) into normalized tables: `spells`, `creatures`, `items`, `magic_items`, `classes`, `conditions`, `rules_sections`. Each row keeps the raw JSON plus an `edition` column.
- **Search:** FTS5 for exact and prefix name matches ("fireball" returns Fireball, not Delayed Blast Fireball), plus `sqlite-vec` embeddings over rules text for fuzzy questions ("can I grapple while prone?").
- **Homebrew:** a `source` column (`srd-2024`, `srd-2014`, `homebrew`) so the DM can add custom monsters and items through the same tools.
- **Attribution:** the CC-BY-4.0 SRD credit line shown in the app footer.

### Game-state DB (`game.db`)

| Table | Key columns | Purpose |
| --- | --- | --- |
| `campaigns` | id, name, edition | Top-level container |
| `characters` | id, campaign\_id, name, aliases, class, level, max\_hp, ac, stats\_json, is\_pc | PCs and recurring NPCs |
| `sessions` | id, campaign\_id, started\_at, summary | Session log and recap |
| `encounters` | id, session\_id, round, turn\_index, status | Active combat |
| `combatants` | id, encounter\_id, character\_id or creature\_ref, label, initiative, hp, temp\_hp | "Goblin 2" instances |
| `conditions` | combatant\_id, name, source, expires\_on | Prone, concentrating, etc. |
| `resources` | character\_id, kind, current, max | Spell slots, hit dice, rage, ki |
| `events` | id, session\_id, ts, actor, type, payload\_json, reverted\_by | Append-only log for undo and recap |

Current HP and conditions are a projection of `events`, materialized into `combatants` for fast reads. Undo writes a compensating event rather than deleting history. `aliases` resolves table talk ("the dwarf", "Thor") to a character.

## MCP server tools

One TypeScript MCP server (`dnd-mcp`, streamable HTTP on the LAN) owns both databases. Keep the tool count around 15 with short descriptions; small models pick tools more reliably from a short list.

| Tool | Phase | Kind | Does |
| --- | --- | --- | --- |
| `lookup(kind, name)` | 1 | read | Exact or fuzzy fetch of a spell, creature, item, condition or class |
| `search_rules(question)` | 1 | read | Hybrid FTS + vector search over rules sections; returns cited chunks |
| `roll(expr)` | 1 | read | Dice notation (`2d6+3`, advantage) with a seeded log |
| `get_image(subject)` | 1 | read | Cached portrait or token; queues generation if missing |
| `get_party()` | 2 | read | Compact snapshot of PCs and active combatants |
| `start_encounter(creatures[])` | 2 | write | Adds monsters by SRD ref, rolls initiative |
| `next_turn()` | 2 | write | Advances initiative, ticks condition durations |
| `apply_damage(target, amount, type)` | 2 | write | Applies resistance, temp HP, concentration DC |
| `heal(target, amount)` | 2 | write | Caps at max HP, clears unconscious |
| `set_condition(target, name, on, duration?)` | 2 | write | Adds or removes a condition |
| `use_resource(target, kind, n)` | 2 | write | Spell slots, hit dice, class resources |
| `rest(kind, targets?)` | 2 | write | Short or long rest rules |
| `undo(event_id?)` | 2 | write | Reverts the last or a named event |
| `recap(session_id?)` | 2 | read | Builds a session summary from events |

Write tools return the before/after diff (e.g. `Thorin HP 34 → 16, concentration DC 10`) so both the UI and the model can show exactly what changed.

## Request flows

### Lookup: "What's a beholder's AC and what do its eye rays do?"

1. DM types or speaks the question; the app server builds the prompt (system + tools + short history).
2. Model calls `lookup("creature", "beholder")`; the MCP server returns the stat block from `rules.db`.
3. Model answers in 2–3 lines; the UI renders the full stat block card beside it, plus the cached image if one exists.
4. Fast path: if the input is a bare name that FTS matches exactly, skip the model and show the card directly.

### State update: "The ogre crits Thorin for 18, and Mira casts Bless on the party"

1. App server attaches the `get_party()` snapshot to the prompt so names and aliases resolve.
2. Model emits a plan of tool calls: `apply_damage(Thorin, 18, bludgeoning)`, `use_resource(Mira, spell_slot_1, 1)`, `set_condition(Mira, concentrating, on)`, `set_condition(party, blessed, on, 10 rounds)`.
3. **Confirm gate:** the UI shows the proposed diffs as a card. The DM taps Apply (or edits a number). A setting allows auto-apply with a 10-second undo toast once the model is trusted.
4. MCP server validates (target exists, amount is a positive integer), writes events, updates projections, and returns diffs.
5. App server pushes the new state over WebSocket to the DM screen and every player view.
6. Ambiguity (two goblins, unknown name) returns a clarifying question instead of a guess.

## Voice and images

**Voice (phase 2).** Push-to-talk in the browser records a short clip and posts it to a `faster-whisper` (or whisper.cpp) service on Firefly. A small Whisper model on the GPU transcribes a 5-second utterance well under a second. Seed the transcription prompt with character names and the current monsters so "Thorin" and "owlbear" come through correctly. Browsers only allow microphone access on HTTPS or localhost, so the LAN site needs TLS (see Deployment).

**Images.** The SRD has no art, so images are generated or uploaded, never scraped.

- Generate portraits and top-down tokens with ComfyUI (SDXL or Flux) **between sessions**, not at the table, because an image model and the LLM won't share 24GB comfortably.
- A prep job walks the next session's monster list and pre-renders anything missing.
- Store images on disk keyed by `source:slug`; the DM can override any image with an upload.
- At the table, `get_image` only serves from cache, so it is instant.

## Deployment on Firefly

Everything runs as one `docker compose` stack beside the existing Ollama and Hermes setup, reusing the host's Ollama rather than starting a second one.

| Service | Image / runtime | Port | GPU |
| --- | --- | --- | --- |
| `caddy` | Caddy, TLS for `dnd.firefly.lan` or the Tailscale name | 443 | No |
| `web` | SvelteKit (Node adapter): UI + app server + WebSocket | 3000 | No |
| `dnd-mcp` | Node, TypeScript MCP SDK, better-sqlite3 + sqlite-vec | 8787 | No |
| `stt` | faster-whisper server | 9000 | Yes, \~1–2GB |
| `comfyui` | ComfyUI, started only for prep jobs | 8188 | Yes, exclusive |
| Ollama (host) | Existing install | 11434 | Yes |

**Stack choice.** TypeScript end to end (SvelteKit + MCP server) matches the Svelte 5 and TypeScript work already on Firefly and shares Zod schemas between the tool definitions and the UI.

**GPU budget on the 3090 (24GB).** The LLM plus its KV cache at 32k context is the big tenant; Whisper and the embedding model are small. Prefer the same model Hermes already keeps loaded so nothing swaps mid-session. ComfyUI runs only when the LLM is idle (a "prep mode" switch that unloads the LLM via `keep_alive: 0`).

**Access.** LAN plus Tailscale, no public exposure. Caddy issues a certificate (Tailscale HTTPS certs or a local CA) so phones get the microphone. Simple PIN login with a DM role and a read-only player role. Nightly copy of `game.db` to the Synology.

## Roadmap

1. **Phase 0: Data.** Open5e import script, `rules.db` with FTS5 and embeddings, `dnd-mcp` with `lookup`, `search_rules`, `roll`. Test it from Claude Desktop or Hermes before any UI exists.
2. **Phase 1: Lookup app.** SvelteKit DM screen: chat pane, stat block cards, dice log, provider switch (Ollama / OpenAI). Model evaluation harness picks the default model.
3. **Phase 2: State tracking.** `game.db`, write tools, confirm gate, initiative tracker, party HP cards, undo, WebSocket player view.
4. **Phase 3: Voice and images.** Push-to-talk STT, ComfyUI prep job, image cache, session recap from events.
5. **Phase 4: Polish.** Homebrew editor, D&D Beyond-style character import from a JSON or PDF export, encounter difficulty calculator.

## Open questions

- [ ] 2024 rules, 2014 rules, or both per campaign?
- [ ] Standalone app, or also expose `dnd-mcp` as a Hermes Agent skill so the voice assistant can answer rules questions?
- [ ] If Firefly moves to the Ryzen AI 9 HX 470 / 96GB box, re-run the model evaluation: more memory allows bigger models but lower tokens per second.
- [ ] Do players get their own devices (player view), or only the DM screen?
- [ ] Is an OpenAI API key acceptable for the fallback, or local-only?

## Sources

- [Open5e](https://open5e.com) and its API, SRD 2024 and 2014 content
- [D&D 5e SRD API](https://www.dnd5eapi.co/docs)
- [SRD 5.2 Creative Commons FAQ](https://www.tribality.com/?p=35354)
- [Ollama models cheat sheet 2026](https://computingforgeeks.com/?p=167394)
