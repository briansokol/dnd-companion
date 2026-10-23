# D&D Companion — Repo Setup and Backlog

Date: 2026-10-22 · Source architecture: `docs/D&D Companion - Architecture.md`

This document records the decisions made on top of the architecture doc and holds the draft GitHub issues for review. Once approved, the issues are created with `gh` in `briansokol/dnd-companion`.

## Intent

A LAN web app the DM uses at the table. MVP: type or speak a question ("beholder AC", "how does grappling work?") and get a short answer plus the full stat block or rule text, answered by a local model over SRD data. Iteration 2: the DM describes what happens ("the ogre crits Thorin for 18") and party/enemy HP and conditions update on the DM screen and on players' phones.

Success for the MVP: a game night where the DM answers rules and monster questions by typing or speaking, faster than flipping through books, with no cloud calls.

## Decisions (from Brian)

- **MVP scope:** lookup only (monsters, spells, items, rules, conditions), typed **or spoken**. Voice moves up from the doc's Phase 3 into the MVP.
- **No images in the MVP.** The SRD and Open5e carry no art. Image cache, uploads and ComfyUI move to the backlog.
- **2024 rules only.** Import only Open5e `srd-2024` (plus the conditions it needs, see issue 5). No `edition` column, no per-campaign edition setting. Keep a `source` column for future homebrew.
- **Local only.** No OpenAI fallback in the MVP or iteration 2; a backlog issue covers adding it.
- **Default model:** `ornith-1.5:35b` on both the MacBook and Firefly (same model Hermes keeps loaded on Firefly).
- **Player view (iteration 2):** players use their own phones, read-only. Enemy HP is shown as a band, never as numbers. PCs show real numbers.
- **Game night setup:** the app is served from Firefly; every device is on the local network; DM and players usually use iPads. So iPad Safari is the primary target for both the DM screen and the player view (phones must still work for the player view).
- **Iteration 2 combat uses SRD enemies only.** Off-SRD and ad-hoc enemies wait for the backlog homebrew editor.
- **Players can ask the companion SRD questions** (iteration 2), but only through read-only SRD lookup tools; they can never change game state.
- **Players only see Player's Handbook content:** classes, species, backgrounds, feats, spells, mundane equipment, conditions and player-facing rules. No monsters (Monster Manual) and no magic items or Gameplay Toolbox material (DMG).
- **Health bands:** Healthy (>50%), Bloodied (≤50%), Critical (≤25%), Down (0).
- **Portability:** develop natively on the MacBook Pro (M4 Max, 36GB), deploy to Firefly with docker compose. Everything machine-specific comes from environment config.

## Calls I made (check these)

1. **Monorepo with pnpm workspaces:** `apps/web` (SvelteKit, Node adapter), `packages/mcp` (`dnd-mcp`), `packages/shared` (Zod schemas, config loader, shared types). pnpm enabled via corepack (not currently installed).
2. **Environment config:** one typed config module (Zod) reads env vars. Committed profiles `env/mac.env` and `env/firefly.env` hold non-secret defaults (Ollama URL, model names, STT URL, DB paths, ports); a git-ignored `.env` holds secrets and local overrides (PINs). `APP_ENV=mac|firefly` picks the profile. `.env.example` documents every variable.
3. **Ollama native API instead of the OpenAI-compatible endpoint.** Ollama's `/v1` endpoint ignores `num_ctx` and `think`, both of which the doc relies on (32k context, thinking off for tool turns). The agent loop talks to Ollama through a small provider interface, so the backlog OpenAI fallback can add a second implementation.
4. **STT is any OpenAI-style `/v1/audio/transcriptions` endpoint.** faster-whisper has no GPU acceleration on Apple Silicon, so the Mac runs whisper.cpp's server (Metal) and Firefly runs a faster-whisper server container on the 3090. Only the URL differs between profiles.
5. **Confirm gate via dry run.** Every write tool accepts `dry_run: true` and returns the diff without writing. The app server runs proposed write calls as dry runs, shows the diff card, and on Apply re-runs them for real. This keeps the MCP server the single owner of game logic.
6. **No login in the MVP.** It is LAN-only and DM-only. PIN auth arrives in iteration 2 with the player role.
6a. **HTTPS everywhere on Firefly, with a certificate iPads trust without setup.** The DM's iPad needs HTTPS for the mic. Preferred: a real subdomain you own (e.g. `dnd.<your-domain>`) resolving to Firefly's LAN IP, with Caddy getting a Let's Encrypt cert via the DNS-01 challenge, so no device installs anything. Fallback: Caddy's internal CA, with its root cert installed once on each iPad (Caddy serves the cert for download). Players use the same HTTPS site, so there is one origin, secure cookies and `wss` throughout.
7. **Voice input auto-submits** the transcript and shows it as the DM's chat message, so a misheard question is visible.
8. **Rolling history in the MVP is the last ~10 turns, truncated.** Summarizing older turns is deferred until sessions show a need (backlog).
10. **Dry runs return a replayable plan.** The dry run resolves all randomness (initiative rolls, rolled HP) and returns a plan containing those results plus the state version it was computed against. Apply replays exactly that plan as one group (one group id for undo) and is refused if the state version changed; the confirm card then re-runs the dry run and shows the fresh diff.
11. **dnd-mcp is the only process that touches `game.db`.** Besides the MCP endpoint (the ~15 model-facing tools), it serves a small internal HTTP API for the web app: campaign/character CRUD and manual combat controls (never shown to the model), plus a change feed (server-sent events) the web app subscribes to and fans out over WebSocket. Writes from Hermes or Claude Desktop therefore reach the DM screen and players live.
12. **Conditions use 2024 text authored from SRD 5.2.** Recon showed Open5e's `conditions` come from the `core` document, which is tagged 5e-2014 (e.g. old Exhaustion). The importer seeds the 2024 condition definitions from a committed JSON file transcribed from the SRD 5.2 Rules Glossary (CC-BY-4.0) instead.
13. **Monster HP defaults to the stat block average,** with an option to roll per encounter.
13a. **Every rules.db row carries an `audience` column (`player` | `dm`),** set by the importer: creatures and magic items are `dm`; classes, species, backgrounds, feats, spells, mundane items and conditions are `player`; rules sections are tagged from a committed ruleset-to-audience map, and any ruleset not in the map defaults to `dm` and is logged. Search and lookup take an audience filter that the server sets from the caller's role. This also excludes the PHB's beast stat blocks (familiars, Wild Shape) from players, matching "no monsters".
13b. **The importer adds `species`, `backgrounds` and `feats` tables** (Open5e srd-2024 has 9, 4 and 17), since players will ask about them and the architecture doc's table list omitted them.
14. **Labels:** `area:infra`, `area:data`, `area:mcp`, `area:agent`, `area:web`, `area:voice`, `area:eval`. **Milestones:** `MVP: Lookup`, `Iteration 2: Party & Combat`, `Backlog`.

## Repo setup done directly (not ticketed)

Done right after this document is approved, before issues are created:

- `AGENTS.md` at the root: project purpose, design principles from the architecture doc ("the model interprets; code computes", etc.), repo layout, commands (filled in for real by issue 1), conventions (TypeScript strict, Zod at boundaries, TDD for game logic, one issue per branch/PR), environment profiles, and links to the architecture doc and this spec.
- `CLAUDE.md` containing only a pointer to `AGENTS.md`.
- `.serena/project.yml` for TypeScript, with ignored paths for `node_modules`, build output and `data/`.
- `.gitignore`, `.env.example` skeleton, `.editorconfig`.
- Labels and milestones created in GitHub.

## What's left to the builder

Library choices not named here (dice parser, WebSocket library, migration tool, UI component approach), exact prompt wording, chunk sizes for embeddings, visual design of cards and screens, and test framework details beyond "Vitest".

---

## Draft issues

Format: **#. Title** · labels · depends on. Each body becomes the issue description, with acceptance criteria as a checklist.

### Milestone: MVP: Lookup

**1. Scaffold pnpm monorepo with lint, typecheck, test, and CI** · `area:infra` · —
Set up the workspace: `apps/web`, `packages/mcp`, `packages/shared`. TypeScript strict, ESLint + Prettier, Vitest, root scripts (`dev`, `build`, `test`, `lint`, `typecheck`). GitHub Actions runs lint, typecheck, test on PRs.
- [ ] `corepack enable` + pinned `packageManager` in root `package.json`
- [ ] `pnpm -r test` / `lint` / `typecheck` pass on a fresh clone
- [ ] CI workflow green on a PR
- [ ] `AGENTS.md` commands section updated to the real commands

**2. Typed environment config with Mac and Firefly profiles** · `area:infra` · 1
`packages/shared/config`: Zod-validated config loaded from `env/${APP_ENV}.env` then `.env`. Covers Ollama base URL, chat model, embedding model, `num_ctx`, STT URL, DB paths, ports, MCP URL.
- [ ] `env/mac.env`, `env/firefly.env`, `.env.example` committed; `.env` git-ignored
- [ ] App fails fast at startup with a clear message on missing/invalid config
- [ ] Defaults: model `ornith-1.5:35b`, embeddings `nomic-embed-text`, `num_ctx` 32768
- [ ] Unit tests for loading and validation

**3. Local dev setup script and docs for the Mac** · `area:infra` · 2
One command checks prerequisites and prepares the Mac: Node/pnpm, Ollama running, required models pulled (`ornith-1.5:35b`, `nomic-embed-text`), whisper.cpp server available.
- [ ] `pnpm setup:mac` (or `scripts/setup-mac.sh`) is idempotent and reports what's missing
- [ ] README "Local development" section: from clone to working app

**4. Docker compose stack for Firefly** · `area:infra` · 2
`compose.yaml` with `web` and `dnd-mcp` services; reaches the host's Ollama (`host.docker.internal` with `host-gateway` on Linux). Data volume for `rules.db` (later `game.db`). `caddy` and `stt` are added by issues 18 and 19.
- [ ] `docker compose --env-file env/firefly.env up` starts both services against host Ollama
- [ ] Also runs on the Mac with Docker Desktop for parity testing
- [ ] Images are multi-arch or build for both arm64 and amd64

**5. Open5e srd-2024 importer into rules.db** · `area:data` · 1, 2
Script pulls Open5e v2 and writes normalized tables: `spells`, `creatures`, `items`, `magic_items`, `classes`, `species`, `backgrounds`, `feats`, `conditions`, `rules_sections`. Each row keeps `raw_json`, `slug`, `name`, `source` (`srd-2024`) and `audience` (`player` | `dm`, see call 13a). Findings from recon: `document__key=srd-2024` filters creatures (331), spells (339), classes and rules, but **the items and magicitems endpoints ignore it** (filter client-side on `document.key`; items returns 440 rows, of which 203 are srd-2024, and magicitems 2322, of which 760 are). Open5e's conditions are 2014 text (`core` document), so conditions come from a committed `data/seed/conditions-2024.json` transcribed from the SRD 5.2 Rules Glossary.
- [ ] `pnpm data:import` builds `data/rules.db` from scratch, idempotently
- [ ] Handles pagination and retries; records import date and counts
- [ ] Recorded API fixtures for tests (no network in CI)
- [ ] Row counts logged and sanity-checked
- [ ] Every row has an audience; unmapped rulesets default to `dm` and are listed in the import log

**6. Name search with FTS5** · `area:data` · 5
FTS5 index over names (and aliases where present) for every kind. Exact match ranks first, then prefix, then fuzzy: "fireball" returns Fireball before Delayed Blast Fireball.
- [ ] Search function returns ranked candidates with kind + slug
- [ ] Tests cover exact, prefix, case, punctuation ("Tasha's"), and no-match
- [ ] Audience filter: `player` never returns creatures or magic items

**7. Rules embeddings with sqlite-vec and hybrid search** · `area:data` · 5
Chunk `rules_sections` (and condition/spell rule text where useful), embed with the configured Ollama embedding model, store in sqlite-vec. Hybrid search merges FTS and vector results.
- [ ] Embedding runs as part of import (or a follow-up step) and is resumable
- [ ] Hybrid search returns top-k chunks with section title and source for citation
- [ ] Audience filter applied to both FTS and vector results
- [ ] Spot-check set of ~10 questions ("can I grapple while prone?") returns a relevant chunk in the top 3

**8. dnd-mcp server skeleton (streamable HTTP)** · `area:mcp` · 2
TypeScript MCP SDK server, streamable HTTP on the configured port, read-only access to `rules.db`, Zod tool schemas from `packages/shared`, health endpoint.
- [ ] Starts with `pnpm --filter mcp dev`; `/health` reports DB status
- [ ] Docs for connecting from Claude Desktop and Hermes Agent
- [ ] Tool descriptions kept terse (small-model friendly)

**9. MCP tool: lookup(kind, name)** · `area:mcp` · 6, 8
Exact or fuzzy fetch of a spell, creature, item, magic item, condition, class or rule. Returns a structured record the UI can render as a card. Multiple close matches return candidates instead of a guess.
- [ ] Tested against fixtures for every kind
- [ ] Ambiguous names return a candidates list
- [ ] Accepts an audience filter (defaults to `dm` in the MVP); `player` audience gets a plain "not available to players" result for DM-only content
- [ ] Verified from Claude Desktop or Hermes

**10. MCP tool: search_rules(question)** · `area:mcp` · 7, 8
Hybrid search returning cited chunks (section, source).
- [ ] Returns top 3–5 chunks within a token budget
- [ ] Verified from Claude Desktop or Hermes

**11. MCP tool: roll(expr)** · `area:mcp` · 8
Dice notation: `2d6+3`, `d20`, advantage/disadvantage, keep highest/lowest. Returns each die and the total. Seedable RNG for tests.
- [ ] Parser rejects invalid expressions with a clear error
- [ ] Deterministic tests with a fixed seed

**12. SvelteKit DM screen shell** · `area:web` · 1, 2
Node adapter, layout with chat pane, card pane and dice log. SRD CC-BY-4.0 attribution in the footer. iPad Safari (landscape) is the primary target; laptop browsers must also work.
- [ ] Layout renders with placeholder data
- [ ] Attribution footer present

**13. Agent loop: Ollama provider + MCP client + tool calling** · `area:agent` · 2, 8
Server-side loop: build prompt (system + tool schemas + last ~10 turns), call Ollama's native chat API with `num_ctx` from config and thinking off, execute tool calls through an MCP client to `dnd-mcp`, loop until a final answer. Stream text and tool results to the browser. Provider interface so an OpenAI provider can be added later.
- [ ] End-to-end: "What's a beholder's AC?" calls `lookup` and answers in 2–3 lines
- [ ] Tool-call loop capped (e.g. 5 iterations) with a graceful failure message
- [ ] Unit tests with a fake provider and fake MCP server

**14. Result cards: stat block, spell, item, condition, rule** · `area:web` · 9, 12
Render structured tool results as cards in the card pane next to the chat answer. Rule chunks show their citation.
- [ ] One card component per kind, rendered from real `rules.db` data
- [ ] Long stat blocks readable on a tablet

**15. Fast path for bare names** · `area:agent` · 6, 14
If the input is a bare name with an exact FTS match, skip the model and show the card directly.
- [ ] "owlbear" shows the Owlbear card with no model call
- [ ] Non-exact or sentence input still goes to the model

**16. Dice log in the UI** · `area:web` · 11, 12
Rolls from the model or typed directly ("roll 2d6+3") appear in the dice log with each die shown.
- [ ] Direct roll input bypasses the model
- [ ] Log persists for the browser session

**17. Model evaluation harness (lookup set)** · `area:eval` · 13
CLI that runs ~30 scripted DM utterances against the agent loop and checks the expected tool calls. Reports pass rate and time to first tool call per model. Iteration 2 extends it with state-update cases (issue 38).
- [ ] `pnpm eval --model <name>` prints pass rate and latency table
- [ ] Cases include ambiguous names, typos, rules questions, and bare names
- [ ] Baseline result for `ornith-1.5:35b` committed (target: under 2s to first tool call)

**18. STT service: whisper.cpp on Mac, faster-whisper on Firefly** · `area:voice` `area:infra` · 2, 4
Both expose `/v1/audio/transcriptions`. Mac: documented whisper.cpp server with Metal (added to the setup script). Firefly: faster-whisper server in compose on the GPU.
- [ ] Same request works against both; only `STT_URL` changes
- [ ] A 5-second clip transcribes in under ~1s on each machine

**19. Caddy with trusted TLS on the LAN** · `area:infra` · 4
Caddy in compose terminates TLS so iPad Safari allows the microphone. Preferred: Let's Encrypt via DNS-01 for a subdomain you own that resolves to Firefly's LAN IP (no device setup). Fallback: Caddy internal CA plus a documented one-time root-cert install on each iPad. Domain, DNS provider token and mode come from env config.
- [ ] DM screen loads over HTTPS with no warning on an iPad on the LAN
- [ ] Mic permission prompt appears on the iPad
- [ ] Cert renewal works unattended (or the fallback's cert lifetime is documented)

**20. Push-to-talk voice input** · `area:voice` `area:web` · 13, 18
Hold-to-record button (and a keyboard shortcut) using MediaRecorder; the server forwards audio to STT with a prompt seeded with D&D vocabulary, then auto-submits the transcript as the DM's message.
- [ ] Works on localhost (Mac) and over HTTPS from an iPad (Firefly)
- [ ] Recording format handled for iPad Safari (MP4/AAC) as well as Chrome (WebM/Opus)
- [ ] Transcript shown as the chat message; errors shown inline
- [ ] Mic permission denial handled with a clear message

**21. Firefly deployment runbook** · `area:infra` · 4, 5, 7, 18, 19
How to deploy and update on Firefly: build/pull images, build `rules.db` (import + embeddings), env file, start, verify.
- [ ] `docs/deploy-firefly.md` written and followed once end to end
- [ ] MVP smoke test checklist (typed lookup, rules question, voice question)

### Milestone: Iteration 2: Party & Combat

**22. game.db schema and migrations** · `area:data` · 2
Tables from the architecture doc: `campaigns`, `characters` (with `aliases`), `sessions`, `encounters`, `combatants`, `conditions`, `resources`, `events`. No `edition` column. Migration tool of the builder's choice.
- [ ] `pnpm db:migrate` creates/upgrades `data/game.db`
- [ ] Schema documented in `packages/mcp` README

**23. Event log and projections with undo** · `area:data` · 22
Every mutation appends an event; current HP/conditions/resources are materialized into `combatants`/`resources`. Undo writes a compensating event and sets `reverted_by`, never deletes.
- [ ] Rebuilding projections from events matches the materialized state (property test)
- [ ] Undo of the last event and of a named event both work

**24. Combat rules engine (pure functions)** · `area:mcp` · —
Deterministic, heavily unit-tested 2024 rules: damage with resistance/immunity/vulnerability, temp HP first, concentration save DC (max(10, half damage)), dropping to 0 HP → unconscious + death saves, massive damage instant death, healing caps at max and clears unconscious/death saves, short/long rest effects.
- [ ] TDD; covers the edge cases above
- [ ] No DB or model dependencies

**25. Campaign, character and session management UI** · `area:web` `area:mcp` · 22
Create a campaign; add PCs and recurring NPCs (name, aliases, class, level, max HP, AC, resources); start and end a session. Backed by dnd-mcp's internal HTTP API (not model-facing tools).
- [ ] CRUD for campaigns and characters
- [ ] Resources editable (spell slots by level, hit dice, class resources)

**26. Name and alias resolution** · `area:mcp` · 22
Resolve "the dwarf", "Thor", "goblin 2" to a character or combatant. Ambiguity returns a clarifying question with candidates.
- [ ] Unit tests for exact, alias, numbered instances, and ambiguous cases

**27. MCP tool: get_party()** · `area:mcp` · 22, 26
Compact JSON snapshot: name, HP, AC, conditions, slots, plus active combatants and initiative order. Budget ~1–3k tokens.
- [ ] Snapshot size measured in a test for a 5-PC, 8-monster encounter

**28. MCP tools: start_encounter and next_turn** · `area:mcp` · 23, 9
Add monsters by SRD ref only (no ad-hoc combatants) with labels ("Goblin 1", "Goblin 2"), HP at stat block average (optional roll), roll initiative, include PCs. `next_turn` advances initiative and ticks condition durations. Establishes the shared write-tool contract used by issues 29–31: `dry_run` returns a plan with resolved rolls and a state version; Apply replays the plan as one event group and is refused if the version changed.
- [ ] Dry run and Apply produce identical initiative and HP
- [ ] Apply against a stale state version is refused with a clear error
- [ ] Round/turn bookkeeping tested

**29. MCP tools: apply_damage and heal** · `area:mcp` · 23, 24, 26
Wire the rules engine to events. Validate target exists and amount is a positive integer.
- [ ] Diff format like `Thorin HP 34 → 16, concentration DC 10`
- [ ] `dry_run` supported

**30. MCP tools: set_condition, use_resource, rest** · `area:mcp` · 23, 24, 26
Conditions with optional duration (including group targets like "party"); resources (spell slots, hit dice, class resources); short/long rest.
- [ ] `dry_run` supported; diffs returned
- [ ] Group targets expand to individual events

**31. MCP tool: undo(event_id?)** · `area:mcp` · 23
Reverts the last or a named event; returns the diff.
- [ ] Undo of a multi-call Apply reverts the whole batch (group id on events)

**32. Agent: state-update flow** · `area:agent` · 13, 27–31
Attach the `get_party()` snapshot to the prompt; the model emits write tool calls; the server runs them as dry runs and returns a proposal instead of applying. Ambiguity results surface as a question to the DM.
- [ ] "The ogre crits Thorin for 18, and Mira casts Bless on the party" yields the four expected proposed calls
- [ ] No write happens without Apply (or auto-apply)

**33. Confirm gate UI** · `area:web` · 32
Proposal card with each diff; DM can edit numbers, then Apply or Reject. Setting for auto-apply with a 10-second undo toast.
- [ ] Edited numbers are re-validated by a fresh dry run before Apply
- [ ] Auto-apply setting persisted per campaign

**34. Realtime state: dnd-mcp change feed + WebSocket fan-out** · `area:web` `area:mcp` · 23
dnd-mcp publishes a change feed (server-sent events) on its internal API for every applied event group, whichever client caused it (web app, Hermes, Claude Desktop). The SvelteKit Node server subscribes and pushes to browsers over `wss`. Payloads are built per role on the server.
- [ ] DM and player clients update within ~1s of an Apply, including writes made from Claude Desktop
- [ ] Reconnects and resyncs after a dropped connection

**35. DM combat screen: initiative tracker and HP cards** · `area:web` · 25, 28, 34
Initiative order with the current turn, HP bars, temp HP, conditions with durations, concentration marker. Manual controls for next turn and quick damage/heal.
- [ ] Live updates from WebSocket
- [ ] Usable on a tablet

**36. PIN auth with DM and player roles** · `area:web` · 2
DM PIN and player PIN from config; join link / QR code for players; session cookie; role checks on routes and WebSocket.
- [ ] Player role cannot call any write endpoint; player agent access is read-only (issue 41)
- [ ] PINs set via `.env`, never committed

**37. Player view on iPads and phones (read-only, redacted)** · `area:web` · 34, 36
Tablet-first layout that also works on phones: turn order, PC HP and conditions, enemies as health bands (Healthy >50%, Bloodied ≤50%, Critical ≤25%, Down). Redaction happens on the server; enemy HP numbers, AC and stat blocks never reach the player's browser.
- [ ] Test asserts player payloads contain no enemy HP/AC fields
- [ ] Works on iPad Safari, iPhone Safari and Android Chrome over the same HTTPS site

**38. Eval harness: state-update cases** · `area:eval` · 17, 32
Add ~20 cases: damage, healing, conditions, resources, group targets, ambiguous names.
- [ ] Pass rate reported separately for lookups and state updates

**39. Seed STT prompt with party and combatant names** · `area:voice` · 20, 27
Include character names, aliases and current monsters in the transcription prompt so "Thorin" and "owlbear" come through.
- [ ] Before/after comparison on a few recorded clips

**40. Nightly game.db backup to the Synology** · `area:infra` · 22
Safe SQLite backup (`.backup`, not a file copy) on a schedule to the NAS; retention documented.
- [ ] Restore tested once

**41. Player SRD lookups (read-only companion)** · `area:agent` `area:web` · 13, 14, 36, 37
Players can type (or push-to-talk) SRD questions from the player view and get the same short answer + card experience as the DM. Players see Player's Handbook content only: the server forces `audience=player` on every lookup and search, so monsters, magic items and DM-only rules never reach them. The agent runs with a player tool allowlist of `lookup` and `search_rules` only: no `roll`, no `get_party`, no write tools, no game-state snapshot in the prompt. Enforced on the server (tools filtered before the model sees them, and any non-allowlisted call rejected before reaching dnd-mcp), not just in the UI. Each player's conversation is private to their device. Requests share one Ollama queue; DM requests go to the front.
- [ ] Test: a player-role agent turn cannot reach any write tool or `get_party`, even if the model emits the call
- [ ] Test: a player asking "what's a beholder's AC?" or about a magic item gets no stat block or item data
- [ ] Fast path for bare names works for players (and respects the audience filter)
- [ ] DM request latency is not blocked behind queued player requests

### Milestone: Backlog

One-paragraph placeholder issues; details get written when picked up.

**42. Image cache and DM uploads; get_image tool** · `area:mcp` `area:web`
**43. ComfyUI prep job and "prep mode" (unload LLM with keep_alive: 0)** · `area:infra`
**44. Session recap from events (recap tool + UI)** · `area:mcp` `area:web`
**45. OpenAI fallback provider with per-task routing** · `area:agent`
**46. Homebrew editor (source = homebrew)** · `area:web` `area:data`
**47. Character import from D&D Beyond JSON/PDF export** · `area:web`
**48. Encounter difficulty calculator** · `area:web`
**49. Summarize older conversation turns** · `area:agent`
**50. Expose dnd-mcp as a Hermes Agent skill** · `area:mcp`
