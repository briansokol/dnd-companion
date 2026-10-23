#!/usr/bin/env bash
# Updates Firefly to the latest main and restarts the compose stack.
# Prints each step and its result; stops at the first failure.
# Pass --no-pull to redeploy the current checkout.

set -u

# Everything lives in main so bash has read the whole script before git pull
# replaces it on disk.
main() {
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$ROOT" || exit 1
  LOG="$(mktemp)"
  trap 'rm -f "$LOG"' EXIT

  ENV_FILE=env/firefly.env
  compose() { docker compose --env-file "$ENV_FILE" "$@"; }
  # The containers run as you, so files they write to data/ are yours.
  export HOST_UID HOST_GID
  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"

  if [ "${1:-}" = "--no-pull" ]; then
    step "Pulling latest code"
    ok "skipped (--no-pull), at $(git log -1 --format='%h %s')"
  else
    step "Pulling latest code"
    before="$(git hash-object "$0")"
    run git pull --ff-only || fail "Commit or stash local changes, then re-run"
    ok "at $(git log -1 --format='%h %s')"
    # Re-run the new version of this script if the pull changed it.
    if [ "$(git hash-object "$0")" != "$before" ]; then
      echo "    Deploy script changed; restarting it"
      exec "$0" --no-pull
    fi
  fi

  step "Preparing data/"
  run mkdir -p data || fail "Could not create $ROOT/data"
  [ -w data ] || fail "$ROOT/data is not writable by $(id -un)" "Run: sudo chown $(id -u):$(id -g) data"
  ok "$ROOT/data"

  step "Checking Ollama from a container"
  ollama_url="$(sed -n 's/^OLLAMA_BASE_URL=//p' "$ENV_FILE")"
  node_image="node:$(tr -d '[:space:]v' <.nvmrc)-slim"
  run docker run --rm --add-host host.docker.internal:host-gateway "$node_image" \
    node -e "fetch('$ollama_url/api/version').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" ||
    fail "Ollama is not reachable at $ollama_url from inside Docker" \
      "Make sure Ollama is running and listening beyond localhost (OLLAMA_HOST=0.0.0.0)." \
      "See docs/runbooks/firefly.md"
  ok "$ollama_url"

  step "Building images"
  run compose build || fail "Build failed"
  ok "web, dnd-mcp"

  step "Starting stack"
  run compose up -d --wait --wait-timeout 120 || fail "Stack did not become healthy" "Logs: docker compose logs"
  ok "started"

  step "Checking health"
  compose ps --format '{{.Service}}: {{.Health}}' | sed 's/^/    /'
  ok "web on port $(sed -n 's/^WEB_PORT=//p' "$ENV_FILE")"
}

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32mOK\033[0m      %s\n' "$1"; }
fail() {
  printf '    \033[31mFAILED\033[0m  %s\n' "$1"
  shift
  for hint in "$@"; do printf '            %s\n' "$hint"; done
  if [ -s "$LOG" ]; then
    echo "    Last output:"
    tail -n 20 "$LOG" | sed 's/^/      /'
  fi
  exit 1
}
# Runs a command with its output captured, shown only if the step fails.
run() { "$@" >"$LOG" 2>&1; }

main "$@"
