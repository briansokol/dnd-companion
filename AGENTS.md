# AGENTS.md

Instructions for coding agents (Claude Code, Codex, etc.) working in this repo.

## What this is

D&D Companion: a LAN web app a DM uses at the table. MVP answers rules and stat questions (typed or spoken) from the 2024 SRD using a local model through Ollama. Iteration 2 tracks party and combat state from plain-language DM updates, with a read-only player view.

- Architecture: `docs/D&D Companion - Architecture.md`
- Decisions and backlog: `docs/superpowers/specs/2026-10-22-dnd-companion-backlog-design.md` (where the two disagree, the spec wins)
- Work is tracked as GitHub issues in `briansokol/dnd-companion`, grouped by milestone (`MVP: Lookup`, `Iteration 2: Party & Combat`, `Backlog`).

## Design rules

- **The model interprets; code computes.** HP, resistances, concentration, death saves and dice are deterministic code. The model only chooses tool calls.
- **State lives in the database, not the context window.** Each turn rebuilds a compact prompt from the DB.
- **Retrieve, don't memorize.** Rules come from `rules.db` through tools.
- **One tool surface.** `dnd-mcp` is the only process that opens `rules.db` and `game.db`. The web app talks to it over MCP (model-facing tools) or its internal HTTP API (CRUD, manual controls, change feed).
- **Every mutation is an event.** Undo writes a compensating event. Write tools support `dry_run`.
- **2024 rules only.** Player-role requests only ever see `audience = player` content.
- **Local only.** No cloud model calls.

## Layout

Planned (created by issue 1):

```
apps/web          SvelteKit (Node adapter): UI, agent loop, WebSocket
packages/mcp      dnd-mcp: MCP server, internal API, rules.db + game.db
packages/shared   Zod schemas, config loader, shared types
env/              committed per-machine profiles (mac.env, firefly.env)
data/             generated databases (git-ignored) and committed seed files (data/seed/)
docs/             architecture, specs, runbooks
```

## Commands

Filled in by issue 1. Until then there is no build.

## Environment

- `APP_ENV=mac|firefly` selects `env/${APP_ENV}.env` (non-secret defaults). A git-ignored `.env` holds secrets and local overrides. `.env.example` documents every variable.
- Never hard-code hosts, ports, model names or paths. Add them to the config schema in `packages/shared`.
- Mac: Ollama runs natively on `localhost:11434`; STT is whisper.cpp server. Firefly: docker compose, host Ollama, faster-whisper container, Caddy TLS.
- Default chat model `ornith-1.5:35b`, embeddings `nomic-embed-text`, `num_ctx` 32768, thinking off for tool turns. Use Ollama's native API.

## Conventions

- TypeScript strict. Validate at boundaries (tool inputs, HTTP, env) with Zod.
- TDD for game logic (rules engine, events, dice, search ranking). Tests must not hit the network; use recorded fixtures.
- One issue per branch and PR. Reference the issue (`Closes #N`). Keep changes scoped to the issue.
- Keep MCP tool descriptions short; small local models choose tools more reliably from terse lists.
- Update this file when commands, layout or conventions change.

## Code navigation

Serena is configured (`.serena/project.yml`, TypeScript + Svelte). Prefer its symbol tools for reading and editing code files.
