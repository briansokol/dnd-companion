# D&D Companion

A LAN web app a DM uses at the table. It answers rules and stat questions, typed or spoken, from the 2024 SRD using a local model through Ollama.

See [AGENTS.md](AGENTS.md) for the repo layout, commands and conventions, and `docs/` for the architecture and specs.

## Local development

On the Mac, from a fresh clone:

1. Check prerequisites. The setup script runs every check before exiting, prints install hints for anything missing, and is safe to re-run:

   ```sh
   ./scripts/setup-mac.sh
   ```

   Once pnpm is installed you can run it as `pnpm setup:mac`. It checks:
   - **Node** at the version in `.nvmrc` or newer (install with `nvm install && nvm use`)
   - **pnpm**, enabled through corepack at the version pinned in `package.json` (the script runs `corepack enable` for you)
   - **Ollama** installed and running at `OLLAMA_BASE_URL` (the script tells you to start it; it never starts it for you)
   - **Models** `CHAT_MODEL` and `EMBED_MODEL` (the script pulls any that are missing)
   - **whisper.cpp** (`whisper-server` on your PATH)

   Settings come from `env/mac.env`, overridden by `.env` and then by real environment variables.

2. Fix anything reported as `MISSING` and run the script again until every line says `OK` or `FIXED`.

3. Install dependencies and create your local config:

   ```sh
   pnpm install
   cp .env.example .env
   ```

4. Start everything in watch mode:

   ```sh
   pnpm dev
   ```

   Open the URL Vite prints for the web app (http://localhost:5173 by default).

## Deploying to Firefly

Firefly runs the app with docker compose against Ollama on the host. After the first-time setup in [the Firefly runbook](docs/runbooks/firefly.md), deploy or update with:

```sh
./scripts/deploy-firefly.sh
```
