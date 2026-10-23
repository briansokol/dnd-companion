# Running the stack on Firefly

Firefly runs `web` and `dnd-mcp` with docker compose. Ollama runs natively on the host so it keeps the GPU to itself. The containers reach it at `host.docker.internal`. Images build on Firefly from the checkout, so there is no registry.

## First-time setup

1. Install Docker Engine and the compose plugin by following [Install Docker Engine](https://docs.docker.com/engine/install/). To run `docker` without `sudo`, add yourself to the `docker` group and then log in again:

   ```sh
   sudo usermod -aG docker "$USER"
   ```

2. Install Ollama and pull the models named in `env/firefly.env`:

   ```sh
   curl -fsSL https://ollama.com/install.sh | sh
   ollama pull ornith-1.5:35b
   ollama pull nomic-embed-text
   ```

3. Make Ollama listen beyond localhost. By default it binds to `127.0.0.1`, which containers cannot reach on Linux. Open a systemd override:

   ```sh
   sudo systemctl edit ollama
   ```

   Add the following lines, then save:

   ```ini
   [Service]
   Environment="OLLAMA_HOST=0.0.0.0"
   ```

   Restart Ollama to apply the setting:

   ```sh
   sudo systemctl restart ollama
   ```

   With `0.0.0.0`, Ollama also accepts connections from the rest of your LAN. To keep it off the LAN, block port 11434 in the host firewall except from Docker networks.

4. Clone the repo:

   ```sh
   git clone https://github.com/briansokol/dnd-companion.git
   cd dnd-companion
   ```

## Deploying and updating

Run the deploy script from the checkout:

```sh
./scripts/deploy-firefly.sh
```

It prints each step and its result, and stops at the first failure with a hint and the last lines of output. The steps are:

1. Pull the latest code with `git pull --ff-only`. If the pull changes the script, it restarts itself.
2. Create `data/` and check that you can write to it.
3. Check that Ollama answers at `OLLAMA_BASE_URL` from inside a container.
4. Build the images.
5. Start the stack and wait for both services to report healthy.
6. Print each service's health.

To redeploy without pulling, pass `--no-pull`. The web app listens on `WEB_PORT` (3000).

To read logs or stop the stack, run:

```sh
docker compose --env-file env/firefly.env logs -f
docker compose --env-file env/firefly.env down
```

## Data and backups

The databases live in the checkout's `data/` folder, which compose mounts at `/data` in `dnd-mcp`. Git ignores the database files. `dnd-mcp` runs with your user and group IDs, so files it writes there belong to you. To back up, copy `data/*.db` while the stack is stopped, or point your backup tool at `data/`.

## Configuration

The containers read `env/firefly.env` through the config loader (`APP_ENV=firefly`). A `.env` file is not passed into the containers. To change a setting, edit `env/firefly.env` and run the deploy script again.

## Running the same stack on the Mac

Docker Desktop can run the Firefly stack unchanged, which is useful for parity testing. Docker Desktop provides `host.docker.internal` and forwards it to Ollama on localhost, so step 3 of the first-time setup does not apply. Run either of these:

```sh
./scripts/deploy-firefly.sh --no-pull
docker compose --env-file env/firefly.env up --build
```

Each machine builds images for its own architecture: arm64 on the Mac and amd64 on Firefly.
